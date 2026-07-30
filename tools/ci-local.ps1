<#
.SYNOPSIS
    Единый локальный гейт QA-вики. Тот же набор шагов гоняет GitHub Actions.

.DESCRIPTION
    Порядок шагов подобран так, чтобы дешёвые проверки падали первыми:
    структура и frontmatter → контракт пайплайна → самотест генератора отчёта →
    паритет скиллов → качество текстов → генерируемые артефакты и их идемпотентность.

.EXAMPLE
    pwsh tools/ci-local.ps1
    pwsh tools/ci-local.ps1 -SkipGeneratedDiffCheck   # вне git
#>
param(
    [string]$Root = (Resolve-Path ".").Path,
    [switch]$SkipGeneratedDiffCheck,
    [switch]$WriteGithubSummary
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "==> $Name"
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Name"
    }
}

function Assert-CleanGeneratedFile {
    param(
        [string]$Path,
        [string]$FixCommand
    )

    git diff --exit-code -- $Path
    if ($LASTEXITCODE -ne 0) {
        throw "$Path is stale. Run '$FixCommand' locally and commit the result."
    }
}

function Write-StepSummary {
    param(
        [string]$Title,
        [string]$FilePath
    )

    if (-not $WriteGithubSummary) { return }
    & ./tools/write-ci-summary.ps1 -Title $Title -FilePath $FilePath -InputText ""
}

function Invoke-WikiQuality {
    Write-Host ""
    Write-Host "==> Wiki quality"
    $global:LASTEXITCODE = 0
    if (-not $WriteGithubSummary) {
        & ./tools/wiki-quality.ps1
        if ($LASTEXITCODE -ne 0) { throw "Step failed: Wiki quality" }
        return
    }
    $report = & ./tools/wiki-quality.ps1
    $status = $LASTEXITCODE
    $report | Tee-Object -FilePath wiki-quality-report.md
    Write-StepSummary -Title "Wiki quality" -FilePath "wiki-quality-report.md"
    if ($status -ne 0) { throw "Step failed: Wiki quality" }
}

$rootPath = Resolve-Path -LiteralPath $Root
Push-Location $rootPath
try {
    Invoke-Step "Wiki audit" {
        & ./tools/wiki-audit.ps1
    }

    Invoke-Step "Verify QA pipeline contract" {
        & ./tools/verify-qa-pipeline.ps1
    }

    # Генератор отчёта — часть поставки, а не вспомогательный скрипт: его самотест
    # обязан включать негативные кейсы, иначе «зелёный» валидатор ничего не доказывает.
    Invoke-Step "Report generator self-test" {
        & python tools/test-qa-report.py
    }

    Invoke-Step "Verify agent skills" {
        & ./tools/verify-agent-skills.ps1
    }

    Invoke-WikiQuality

    Invoke-Step "Build INDEX.md" {
        & ./tools/build-index.ps1
    }

    if (-not $SkipGeneratedDiffCheck) {
        Assert-CleanGeneratedFile -Path "docs/INDEX.md" -FixCommand "pwsh tools/ci-local.ps1"
    }

    Invoke-Step "Build corpus snapshot" {
        & python tools/build_embeddings.py --mode offline-text
    }

    if (-not $SkipGeneratedDiffCheck) {
        Assert-CleanGeneratedFile -Path "embeddings/manifest.json" -FixCommand "python tools/build_embeddings.py --mode offline-text"
    }

    Invoke-Step "Offline retrieval evals" {
        & python tools/run_offline_retrieval_evals.py --min-precision 0.6 --top-k 5 --top-k-strict 10 --warn-rank 3
    }

    Write-Host ""
    Write-Host "Local CI passed."
}
finally {
    Pop-Location
}

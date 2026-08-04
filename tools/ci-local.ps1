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

# Устаревшие генерируемые файлы копятся здесь и валят прогон в самом конце.
$script:StaleFiles = [System.Collections.Generic.List[string]]::new()

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
        [string]$FixCommand,
        # Строки, меняющиеся при каждой сборке по определению: отметка времени в манифесте
        # корпуса. Без этого исключения проверка не может пройти никогда — файл всегда
        # отличается от закоммиченного, и CI застревает на шаге, который сам же и породил.
        [string[]]$IgnoreLinePattern = @()
    )

    git diff --quiet -- $Path
    if ($LASTEXITCODE -eq 0) { return }

    $changed = @(git diff -U0 -- $Path |
        Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^(\+\+\+|---)' })

    if ($IgnoreLinePattern.Count -gt 0) {
        $changed = @($changed | Where-Object {
            $line = $_
            -not ($IgnoreLinePattern | Where-Object { $line -match $_ })
        })
    }

    if ($changed.Count -eq 0) {
        Write-Host "  ${Path}: различия только в служебных полях, пропускаю"
        return
    }

    git diff -- $Path
    # Не бросаем сразу: следующие шаги тоже пересобирают генерируемые файлы, и обрыв
    # здесь заставлял гонять CI по три раза — каждый прогон доходил на один шаг дальше.
    # Копим и валим в конце, когда все генераторы отработали.
    $script:StaleFiles.Add("$Path is stale. Run '$FixCommand' locally and commit the result.") | Out-Null
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

    Invoke-Step "QA toolkit self-test" {
        & python -m unittest discover -s tools/qa-toolkit/tests -p "test_*.py"
    }

    Invoke-Step "UI accessibility helper self-test" {
        & node --test tools/ui-evidence/test-axe-accessibility.js
    }

    Invoke-Step "UI functional core backward compatibility" {
        & node --test tools/ui-evidence/test-functional-screenshots.js
    }

    Invoke-Step "UI functional optional live smoke" {
        & node -e "const result=require('./tools/ui-evidence/pw-env').liveSmokePrerequisites(); process.exit(result.available ? 0 : result.reason === 'browser' ? 2 : 1)" 2>$null
        $prerequisiteStatus = $LASTEXITCODE
        if ($prerequisiteStatus -eq 0) {
            & node --test tools/ui-evidence/test-functional-runner.js
        }
        else {
            if ($prerequisiteStatus -eq 2) {
                Write-Host "SKIPPED optional live smoke: Browser unavailable"
            }
            else {
                Write-Host "SKIPPED optional live smoke: Playwright unavailable"
            }
            $global:LASTEXITCODE = 0
        }
    }

    Invoke-Step "Agent Skills validator self-test" {
        & python tools/test_validate_agent_skills.py
    }

    Invoke-Step "Deterministic skill evals" {
        & python tools/test_validate_skill_evals.py
        if ($LASTEXITCODE -eq 0) {
            & python tools/validate_skill_evals.py
        }
        if ($LASTEXITCODE -eq 0) {
            & python tools/validate_skill_evals.py --results agent-skills/evals/results.fixture.json --partial-results
        }
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
        Assert-CleanGeneratedFile -Path "embeddings/manifest.json" `
            -FixCommand "python tools/build_embeddings.py --mode offline-text" `
            -IgnoreLinePattern '"generated_at"'
    }

    Invoke-Step "Offline retrieval evals" {
        & python tools/run_offline_retrieval_evals.py --min-precision 0.6 --top-k 5 --top-k-strict 10 --warn-rank 3
    }

    if ($script:StaleFiles.Count -gt 0) {
        Write-Host ""
        Write-Host "Генерируемые файлы устарели: $($script:StaleFiles.Count)"
        foreach ($item in $script:StaleFiles) { Write-Host "- $item" }
        throw "Stale generated files: $($script:StaleFiles.Count). Файлы уже пересобраны — закоммить результат."
    }

    Write-Host ""
    Write-Host "Local CI passed."
}
finally {
    Pop-Location
}

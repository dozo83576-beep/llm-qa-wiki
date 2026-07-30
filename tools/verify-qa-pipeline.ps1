<#
.SYNOPSIS
    Проверяет контракт QA-пайплайна, а при указании -ProjectRoot — и фактическое
    состояние фаз в конкретном проекте.

.DESCRIPTION
    Без -ProjectRoot работает как self-check контракта: структура JSON, отсутствие
    циклов и висячих зависимостей, наличие скилла под каждую фазу. Этот режим гоняет CI.

    С -ProjectRoot отвечает на вопрос «какая фаза следующая»: фаза считается
    закрытой, когда её артефакт существует и непуст. Это даёт resume после
    перезапуска сессии — состояние живёт в файлах, а не в памяти агента.

.EXAMPLE
    pwsh tools/verify-qa-pipeline.ps1
    pwsh tools/verify-qa-pipeline.ps1 -ProjectRoot D:\Rabota\projects\<проект>
    pwsh tools/verify-qa-pipeline.ps1 -ProjectRoot D:\Rabota\projects\<проект> -RequirePhase design
#>
param(
    [string]$Root = (Resolve-Path ".").Path,
    [string]$ProjectRoot,
    [string]$RequirePhase
)

$ErrorActionPreference = "Stop"

$rootPath = (Resolve-Path -LiteralPath $Root).Path
$contractPath = Join-Path $rootPath "resources/qa-pipeline-contract.json"
$skillsRoot = Join-Path $rootPath "agent-skills"
$failures = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path -LiteralPath $contractPath)) {
    Write-Host "Отсутствует контракт: resources/qa-pipeline-contract.json"
    exit 1
}

try {
    $contract = Get-Content -Raw -Encoding UTF8 -LiteralPath $contractPath | ConvertFrom-Json
}
catch {
    Write-Host "Контракт не разбирается как JSON: $($_.Exception.Message)"
    exit 1
}

$phases = @($contract.phases)
if ($phases.Count -eq 0) {
    $failures.Add("В контракте нет ни одной фазы.") | Out-Null
}

$phaseById = @{}
foreach ($phase in $phases) {
    foreach ($field in @("id", "skill", "title", "artifact", "gate")) {
        if ([string]::IsNullOrWhiteSpace([string]$phase.$field)) {
            $failures.Add("Фаза '$($phase.id)': не заполнено поле '$field'.") | Out-Null
        }
    }
    if ($phaseById.ContainsKey($phase.id)) {
        $failures.Add("Дубль id фазы: $($phase.id)") | Out-Null
    }
    else {
        $phaseById[$phase.id] = $phase
    }
}

# Зависимости: только на объявленные фазы и только на объявленные РАНЬШЕ по списку.
# Ссылка вперёд означала бы цикл или недостижимую фазу.
$seen = [System.Collections.Generic.HashSet[string]]::new()
foreach ($phase in $phases) {
    foreach ($dep in @($phase.requires)) {
        if (-not $phaseById.ContainsKey($dep)) {
            $failures.Add("Фаза '$($phase.id)' зависит от несуществующей фазы '$dep'.") | Out-Null
        }
        elseif (-not $seen.Contains($dep)) {
            $failures.Add("Фаза '$($phase.id)' зависит от '$dep', объявленной позже — цикл или недостижимая фаза.") | Out-Null
        }
    }
    [void]$seen.Add($phase.id)
}

# Скилл под каждую фазу должен существовать в каноне, иначе маршрут обрывается.
foreach ($phase in $phases) {
    if ([string]::IsNullOrWhiteSpace([string]$phase.skill)) { continue }
    $skillFile = Join-Path $skillsRoot (Join-Path $phase.skill "SKILL.md")
    if (-not (Test-Path -LiteralPath $skillFile)) {
        $failures.Add("Фаза '$($phase.id)': нет скилла agent-skills/$($phase.skill)/SKILL.md") | Out-Null
    }
}

Write-Host "QA pipeline contract"
Write-Host "Root: $rootPath"
Write-Host "Phases: $($phases.Count)"

if ($failures.Count -gt 0) {
    Write-Host "Failures: $($failures.Count)"
    foreach ($failure in $failures) { Write-Host "- $failure" }
    exit 1
}
Write-Host "Failures: 0"

if (-not $ProjectRoot) { exit 0 }

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Write-Host ""
    Write-Host "Каталог проекта не найден: $ProjectRoot"
    exit 1
}

$projectPath = (Resolve-Path -LiteralPath $ProjectRoot).Path
Write-Host ""
Write-Host "Project: $projectPath"
Write-Host ""

$done = [System.Collections.Generic.HashSet[string]]::new()
$nextPhase = $null
foreach ($phase in $phases) {
    $artifactPath = Join-Path $projectPath $phase.artifact
    $isDone = $false
    if (Test-Path -LiteralPath $artifactPath -PathType Leaf) {
        $isDone = (Get-Item -LiteralPath $artifactPath).Length -gt 0
    }

    $blockedBy = @(@($phase.requires) | Where-Object { $_ -and -not $done.Contains($_) })

    if ($isDone) {
        [void]$done.Add($phase.id)
        $state = "done"
    }
    elseif ($blockedBy.Count -gt 0) {
        $state = "blocked by: $($blockedBy -join ', ')"
    }
    else {
        $state = "ready"
        if (-not $nextPhase) { $nextPhase = $phase }
    }

    Write-Host ("{0,-9} {1,-12} {2} -> {3}" -f $phase.id, $phase.skill, $state, $phase.artifact)
}

Write-Host ""
if ($nextPhase) {
    Write-Host "Следующая фаза: $($nextPhase.id) — вызывай скилл $($nextPhase.skill)"
}
else {
    Write-Host "Все фазы закрыты."
}

if ($RequirePhase) {
    if (-not $phaseById.ContainsKey($RequirePhase)) {
        Write-Host ""
        Write-Host "Неизвестная фаза в -RequirePhase: $RequirePhase"
        exit 1
    }
    $missing = @(@($phaseById[$RequirePhase].requires) | Where-Object { -not $done.Contains($_) })
    if ($missing.Count -gt 0) {
        Write-Host ""
        Write-Host "Фаза '$RequirePhase' не может стартовать: не закрыты $($missing -join ', ')"
        exit 1
    }
    Write-Host "Фаза '$RequirePhase' может стартовать: все зависимости закрыты."
}

exit 0

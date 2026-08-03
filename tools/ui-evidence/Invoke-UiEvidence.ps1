<#
.SYNOPSIS
    Точка входа сбора UI-доказательств: разрешает окружение и запускает collect.js.

.DESCRIPTION
    Берёт на себя то, на чём теряется время в начале каждого заказа: находит Node, находит модуль
    playwright (глобальная установка либо тот, что приехал с @playwright/mcp) и подставляет NODE_PATH.
    Скрипты доказательств запускаются из командной строки и не зависят от рантайма агента.

.EXAMPLE
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check -Config .\ui-cases.json -ProjectRoot .
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config D:\Rabota\projects\<проект>\ui-cases.json -ProjectRoot D:\Rabota\projects\<проект>
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config .\ui-cases.json -ProjectRoot . -Only TC-001,TC-004
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config .\ui-cases.json -ProjectRoot . -PrepareProfile
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -ProjectRoot . -Approve 20260803-120000-abcd
#>
param(
    [string]$Config,
    [string]$ProjectRoot = (Resolve-Path ".").Path,
    [string]$Url,
    [string[]]$Only,
    [switch]$Check,
    [switch]$Headless,
    [switch]$PrepareProfile,
    [string]$Approve
)

$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "Node.js не найден в PATH. Он нужен для сбора UI-доказательств." }

function Resolve-PlaywrightPath {
    $candidates = @()
    $npmRoot = & npm root -g 2>$null
    if ($LASTEXITCODE -eq 0 -and $npmRoot) {
        $candidates += $npmRoot.Trim()
        $candidates += (Join-Path $npmRoot.Trim() "@playwright\mcp\node_modules")
    }
    $candidates += (Join-Path $PSScriptRoot "node_modules")
    if ($env:USERPROFILE) {
        $candidates += (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "playwright")) { return $candidate }
    }
    return $null
}

$pwPath = Resolve-PlaywrightPath
if (-not $pwPath) {
    throw "Модуль playwright не найден. Установи его: npm i -g playwright; npx playwright install chromium"
}
$env:NODE_PATH = $pwPath
if ($Headless) { $env:UI_EVIDENCE_HEADLESS = "1" }

$collect = Join-Path $PSScriptRoot "collect.js"
$functional = Join-Path $PSScriptRoot "functional-capture.js"
$isFunctional = $false

if ($Config) {
    if (-not (Test-Path -LiteralPath $Config)) { throw "Конфиг не найден: $Config" }
    try {
        $configObject = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    }
    catch {
        throw "Конфиг не является корректным JSON: $Config. $($_.Exception.Message)"
    }
    $isFunctional = ($configObject.runner -eq "functional-screenshots")
}

if ($Approve) {
    if (-not (Test-Path -LiteralPath $ProjectRoot)) { throw "Каталог проекта не найден: $ProjectRoot" }
    & node $functional --out (Resolve-Path -LiteralPath $ProjectRoot).Path --approve $Approve
    exit $LASTEXITCODE
}

if ($PrepareProfile -and -not $isFunctional) {
    throw "-PrepareProfile поддерживается только конфигом runner=functional-screenshots."
}

$entrypoint = if ($isFunctional) { $functional } else { $collect }
$arguments = @($entrypoint)

if ($Check) {
    $arguments += "--check"
    if ($isFunctional) {
        if (-not (Test-Path -LiteralPath $ProjectRoot)) { throw "Каталог проекта не найден: $ProjectRoot" }
        $arguments += @("--config", (Resolve-Path -LiteralPath $Config).Path)
        $arguments += @("--out", (Resolve-Path -LiteralPath $ProjectRoot).Path)
    }
}
else {
    if (-not $Config) { throw "Не задан -Config: путь к JSON с кейсами. Образец: tools/ui-evidence/config.example.json" }
    if (-not (Test-Path -LiteralPath $ProjectRoot)) {
        throw "Каталог проекта не найден: $ProjectRoot. Создай его или укажи существующий — молча создавать каталог по опечатке скрипт не будет."
    }
    $arguments += @("--config", (Resolve-Path -LiteralPath $Config).Path)
    $arguments += @("--out", (Resolve-Path -LiteralPath $ProjectRoot).Path)
    if ($Url) { $arguments += @("--url", $Url) }
    if ($Only) { $arguments += @("--only", ($Only -join ",")) }
    if ($PrepareProfile) { $arguments += "--prepare-profile" }
}

& node @arguments
exit $LASTEXITCODE

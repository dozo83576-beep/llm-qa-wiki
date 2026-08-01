<#
.SYNOPSIS
    Точка входа сбора UI-доказательств: разрешает окружение и запускает collect.js.

.DESCRIPTION
    Берёт на себя то, на чём теряется время в начале каждого заказа: находит Node, находит модуль
    playwright (глобальная установка либо тот, что приехал с @playwright/mcp) и подставляет NODE_PATH.
    Скрипты доказательств запускаются из командной строки и не зависят от рантайма агента.

.EXAMPLE
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Check
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config D:\Rabota\projects\<проект>\ui-cases.json -ProjectRoot D:\Rabota\projects\<проект>
    pwsh tools/ui-evidence/Invoke-UiEvidence.ps1 -Config .\ui-cases.json -ProjectRoot . -Only TC-001,TC-004
#>
param(
    [string]$Config,
    [string]$ProjectRoot = (Resolve-Path ".").Path,
    [string]$Url,
    [string[]]$Only,
    [switch]$Check,
    [switch]$Headless
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
$arguments = @($collect)

if ($Check) {
    $arguments += "--check"
}
else {
    if (-not $Config) { throw "Не задан -Config: путь к JSON с кейсами. Образец: tools/ui-evidence/config.example.json" }
    if (-not (Test-Path -LiteralPath $Config)) { throw "Конфиг не найден: $Config" }
    if (-not (Test-Path -LiteralPath $ProjectRoot)) {
        throw "Каталог проекта не найден: $ProjectRoot. Создай его или укажи существующий — молча создавать каталог по опечатке скрипт не будет."
    }
    $arguments += @("--config", (Resolve-Path -LiteralPath $Config).Path)
    $arguments += @("--out", (Resolve-Path -LiteralPath $ProjectRoot).Path)
    if ($Url) { $arguments += @("--url", $Url) }
    if ($Only) { $arguments += @("--only", ($Only -join ",")) }
}

& node @arguments
exit $LASTEXITCODE

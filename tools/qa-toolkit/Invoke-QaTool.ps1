[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [Parameter(Mandatory = $true)][string]$Config,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [switch]$Preflight,
    [switch]$InstallLocal,
    [string]$Authorization
)

$ErrorActionPreference = "Stop"
$core = Join-Path $PSScriptRoot "qa_toolkit.py"
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
    throw "Python 3 не найден в PATH. Toolkit не устанавливает системные зависимости."
}

$arguments = @($core, "--tool", $Tool, "--config", $Config, "--project-root", $ProjectRoot)
if ($Preflight) { $arguments += "--preflight" }
if ($InstallLocal) { $arguments += "--install-local" }
if ($Authorization) { $arguments += @("--authorization", $Authorization) }

& $python.Source @arguments
exit $LASTEXITCODE

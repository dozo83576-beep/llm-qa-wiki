<#
    ask-wiki — обёртка над tools/ask_wiki.py: offline BM25-поиск по снапшоту вики.

    Использование (из любого cwd):
        pwsh D:\Rabota\llm-qa-wiki\tools\ask-wiki.ps1 "граничные значения форма регистрации"
        pwsh D:\Rabota\llm-qa-wiki\tools\ask-wiki.ps1 "severity против priority" -Top 8
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Query,
    [int]$Top = 5
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) {
    Write-Error "python не найден в PATH"
    exit 2
}

$script = Join-Path $PSScriptRoot 'ask_wiki.py'
& $python.Source $script $Query --top $Top
exit $LASTEXITCODE

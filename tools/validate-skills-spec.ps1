<#
.SYNOPSIS
    Проверка каталога скиллов официальным валидатором Agent Skills.

.DESCRIPTION
    Обёртка над `agentskills validate` (пакет skills-ref, ставится командой
    `uv tool install skills-ref`). Сравнение хешей в verify-agent-skills.ps1 ловит расхождение
    канона и раскатки, но не видит того, что ломает перенос скилла в другой рантайм: посторонние
    поля frontmatter, битый YAML, расхождение `name` с именем каталога.

    Вызывается из tools/verify-agent-skills.ps1. Отсутствие самого валидатора там обрабатывается
    отдельно — этот скрипт считает его наличие предусловием и падает, если его нет.

.PARAMETER Root
    Каталог со скиллами. Каждый подкаталог с SKILL.md проверяется отдельно.

.OUTPUTS
    Код 0 — все скиллы валидны. Код 1 — есть нарушения, они перечислены в выводе.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Error "Каталог скиллов не найден: $Root"
    exit 1
}

$validator = Get-Command agentskills -ErrorAction SilentlyContinue
if (-not $validator) {
    Write-Error "agentskills не найден. Установка: uv tool install skills-ref"
    exit 1
}

$failures = @()
$checked = 0

foreach ($dir in Get-ChildItem -LiteralPath $Root -Directory | Sort-Object Name) {
    $manifest = Join-Path $dir.FullName "SKILL.md"
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        # Каталоги без SKILL.md — это не скиллы (evals, ресурсы), их пропускаем молча.
        continue
    }

    $checked++
    $global:LASTEXITCODE = 0
    $output = & $validator.Source validate $dir.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        $failures += [PSCustomObject]@{ Skill = $dir.Name; Output = ($output | Out-String).Trim() }
    }
}

Write-Host "Agent Skills spec validation"
Write-Host "Root: $Root"
Write-Host "Checked: $checked"
Write-Host "Failures: $($failures.Count)"

if ($failures.Count -gt 0) {
    foreach ($item in $failures) {
        Write-Host ""
        Write-Host "FAIL $($item.Skill)"
        Write-Host $item.Output
    }
    exit 1
}

exit 0

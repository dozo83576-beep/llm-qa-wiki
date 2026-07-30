<#
.SYNOPSIS
    Раскатывает канонические скиллы из tracked source в рантаймы Claude Code и Codex.

.DESCRIPTION
    Канон скиллов хранится в D:\Rabota\llm-qa-wiki\agent-skills. D:\Rabota\.agent-skills — runtime cache.
    Каждый подкаталог с файлом SKILL.md — это скилл.
    Скрипт обновляет runtime cache D:\Rabota\.agent-skills и копирует ТОЛЬКО эти скиллы в:
      - Claude Code: <UserProfile>\.claude\skills\<name>\
      - Codex:       <UserProfile>\.codex\skills\<name>\
    Идемпотентно: целевой каталог конкретного скилла очищается и копируется заново. Чужие скиллы
    в целевых папках не трогаются. Формат SKILL.md общий для обоих рантаймов; файл agents\openai.yaml
    нужен Codex и безвреден для Claude Code.

.PARAMETER Claude
    Раскатывать в Claude Code. Если не указан ни -Claude, ни -Codex — раскатка в оба.

.PARAMETER Codex
    Раскатывать в Codex. Если не указан ни -Claude, ни -Codex — раскатка в оба.

.PARAMETER RuntimeCache
    Обновить D:\Rabota\.agent-skills. Если не указан ни один таргет — обновляется runtime cache, Claude и Codex.

.PARAMETER RuntimeRoot
    Путь runtime cache. По умолчанию D:\Rabota\.agent-skills.

.PARAMETER DryRun
    Только показать, что было бы сделано, без изменений.

.PARAMETER Prune
    Удалить из runtime cache элементы верхнего уровня, которых нет в каноне (кроме logs).
    Защита от сирот вроде тестовых скиллов, скопированных в cache вручную.

.EXAMPLE
    pwsh D:\Rabota\.agent-skills\sync-skills.ps1 -DryRun
    pwsh D:\Rabota\.agent-skills\sync-skills.ps1
    pwsh D:\Rabota\.agent-skills\sync-skills.ps1 -Codex
#>
param(
    [switch]$Claude,
    [switch]$Codex,
    [switch]$RuntimeCache,
    [string]$RuntimeRoot = "D:\Rabota\.agent-skills",
    [switch]$DryRun,
    [switch]$Prune
)

$ErrorActionPreference = "Stop"
$source = $PSScriptRoot

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
    if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside target root. Parent=$parentFull Child=$childFull"
    }
}

# Если ни один таргет не выбран — runtime cache и оба agent runtime.
if (-not $RuntimeCache -and -not $Claude -and -not $Codex) {
    $RuntimeCache = $true
    $Claude = $true
    $Codex = $true
}

$targets = @()
if ($Claude) { $targets += [pscustomobject]@{ Name = "Claude Code"; Path = (Join-Path $env:USERPROFILE ".claude\skills") } }
if ($Codex)  { $targets += [pscustomobject]@{ Name = "Codex";       Path = (Join-Path $env:USERPROFILE ".codex\skills") } }

# Скиллы = подкаталоги канона, содержащие SKILL.md.
$skills = Get-ChildItem -LiteralPath $source -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") }

if (-not $skills) {
    Write-Host "Status: blocked"
    Write-Host "Reason: в $source не найдено ни одного скилла (каталога с SKILL.md)."
    exit 1
}

$modeText = if ($DryRun) { "DRY-RUN" } else { "APPLY" }
Write-Host "Sync skills [$modeText]"
Write-Host "Source: $source"
Write-Host "Skills: $($skills.Count) — $((($skills | Select-Object -ExpandProperty Name) -join ', '))"
Write-Host ""

if ($RuntimeCache) {
    $runtimeRoot = $RuntimeRoot
    Write-Host "==> Runtime cache: $runtimeRoot"
    if (-not (Test-Path -LiteralPath $runtimeRoot)) {
        if ($DryRun) {
            Write-Host "   [dry-run] создать каталог $runtimeRoot"
        }
        else {
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
        }
    }

    foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
        if ($item.Name -eq "logs") { continue }
        $dest = Join-Path $runtimeRoot $item.Name
        if ($DryRun) {
            Write-Host "   [dry-run] $($item.Name) -> $dest"
            continue
        }
        if (Test-Path -LiteralPath $dest) {
            Assert-ChildPath -Parent $runtimeRoot -Child $dest
            Remove-Item -LiteralPath $dest -Recurse -Force
        }
        Copy-Item -LiteralPath $item.FullName -Destination $dest -Recurse -Force
        Write-Host "   synced: $($item.Name)"
    }

    if ($Prune -and (Test-Path -LiteralPath $runtimeRoot)) {
        $sourceNames = Get-ChildItem -LiteralPath $source -Force | Select-Object -ExpandProperty Name
        foreach ($runtimeItem in Get-ChildItem -LiteralPath $runtimeRoot -Force) {
            if ($runtimeItem.Name -eq "logs") { continue }
            if ($sourceNames -contains $runtimeItem.Name) { continue }
            if ($DryRun) {
                Write-Host "   [dry-run] prune: $($runtimeItem.Name) (нет в каноне)"
                continue
            }
            Assert-ChildPath -Parent $runtimeRoot -Child $runtimeItem.FullName
            Remove-Item -LiteralPath $runtimeItem.FullName -Recurse -Force
            Write-Host "   pruned: $($runtimeItem.Name) (нет в каноне)"
        }
    }
    Write-Host ""
}

foreach ($target in $targets) {
    Write-Host "==> $($target.Name): $($target.Path)"
    if (-not (Test-Path -LiteralPath $target.Path)) {
        if ($DryRun) {
            Write-Host "   [dry-run] создать каталог $($target.Path)"
        }
        else {
            New-Item -ItemType Directory -Path $target.Path -Force | Out-Null
        }
    }

    foreach ($skill in $skills) {
        $dest = Join-Path $target.Path $skill.Name
        if ($DryRun) {
            Write-Host "   [dry-run] $($skill.Name) -> $dest"
            continue
        }
        if (Test-Path -LiteralPath $dest) {
            Assert-ChildPath -Parent $target.Path -Child $dest
            Remove-Item -LiteralPath $dest -Recurse -Force
        }
        Copy-Item -LiteralPath $skill.FullName -Destination $dest -Recurse -Force
        Write-Host "   synced: $($skill.Name)"
    }
    Write-Host ""
}

Write-Host "Done [$modeText]."
if ($DryRun) {
    Write-Host "Это был dry-run. Повтори без -DryRun, чтобы применить."
}

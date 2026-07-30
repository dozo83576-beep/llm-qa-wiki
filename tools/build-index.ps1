param(
    [string]$Root = (Resolve-Path ".").Path,
    [string]$Output = "docs/INDEX.md"
)

$ErrorActionPreference = "Stop"
$rootPath = Resolve-Path -LiteralPath $Root
$outPath = Join-Path $rootPath $Output

$contentRoots = @(
    "docs",
    "patterns",
    "prompts",
    "checklists",
    "bug-taxonomy",
    "case-studies",
    "lessons-learned"
)

$rows = [System.Collections.Generic.List[object]]::new()

foreach ($cr in $contentRoots) {
    $full = Join-Path $rootPath $cr
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $filePaths = [string[]]@(Get-ChildItem -LiteralPath $full -Recurse -File -Filter "*.md" | ForEach-Object { $_.FullName })
    [Array]::Sort($filePaths, [StringComparer]::Ordinal)

    foreach ($filePath in $filePaths) {
        $relPath = ($filePath.Substring($rootPath.Path.Length + 1) -replace '\\', '/')
        # Skip the INDEX file itself to keep build-index idempotent
        if ($relPath -eq ($Output -replace '\\', '/')) { continue }
        $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $filePath -ErrorAction SilentlyContinue
        if (-not $content) { continue }

        $title = ""
        $category = ""
        $updated = ""
        $status = ""
        $sourcePriority = ""

        if ($content -match '(?ms)^---\s*\r?\n(.*?)\r?\n---') {
            $fm = $matches[1]
            if ($fm -match '(?im)^title:\s*"?([^"\r\n]+?)"?\s*$') { $title = $matches[1].Trim() }
            if ($fm -match '(?im)^category:\s*"?([^"\r\n]+?)"?\s*$') { $category = $matches[1].Trim() }
            if ($fm -match '(?im)^updated:\s*"?([^"\r\n]+?)"?\s*$') { $updated = $matches[1].Trim() }
            if ($fm -match '(?im)^status:\s*"?([^"\r\n]+?)"?\s*$') { $status = $matches[1].Trim() }
            if ($fm -match '(?im)^source_priority:\s*"?([^"\r\n]+?)"?\s*$') { $sourcePriority = $matches[1].Trim() }
        }

        if (-not $title) {
            $title = [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileName($filePath))
        }

        $chars = ($content -replace "`r`n", "`n").Length

        $rows.Add([pscustomobject]@{
            Path = $relPath
            Title = $title
            Category = $category
            Chars = $chars
            Updated = $updated
            Status = $status
            SourcePriority = $sourcePriority
        }) | Out-Null
    }
}

$totalDocs = $rows.Count
$activeDocs = ($rows | Where-Object { $_.Status -eq "active" }).Count
$redirectDocs = ($rows | Where-Object { $_.Status -eq "redirect" }).Count
$archivedDocs = ($rows | Where-Object { $_.Status -eq "archived" }).Count
$totalChars = ($rows | Measure-Object -Property Chars -Sum).Sum

# Дата подставляется после сборки: если содержимое индекса не изменилось, сохраняется
# прежняя дата — иначе локальная и CI-генерация в разных часовых поясах дают ложный diff.
$updatedToken = "{{UPDATED}}"

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine("---")
[void]$sb.AppendLine('title: "QA Wiki INDEX"')
[void]$sb.AppendLine('category: "navigation"')
[void]$sb.AppendLine("updated: `"$updatedToken`"")
[void]$sb.AppendLine('status: "active"')
[void]$sb.AppendLine('tags: ["index", "navigation"]')
[void]$sb.AppendLine('source_priority: "internal"')
[void]$sb.AppendLine("---")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("# QA Wiki INDEX")
[void]$sb.AppendLine("")
[void]$sb.AppendLine('Автогенерированный индекс всех документов вики. Генерируется через `tools/build-index.ps1`.')
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Сводка")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("- Всего документов: **$totalDocs**")
[void]$sb.AppendLine("- Активных: **$activeDocs**")
[void]$sb.AppendLine("- Redirect-stubs: **$redirectDocs**")
[void]$sb.AppendLine("- Archived: **$archivedDocs**")
[void]$sb.AppendLine("- Суммарный объём: **$totalChars** символов")
[void]$sb.AppendLine("")

# Group by content root
$groupedByRoot = [ordered]@{}
foreach ($cr in $contentRoots) {
    $groupedByRoot[$cr] = $rows | Where-Object { $_.Path.StartsWith($cr + "/") }
}

foreach ($cr in $contentRoots) {
    $group = $groupedByRoot[$cr]
    if (-not $group -or $group.Count -eq 0) { continue }

    [void]$sb.AppendLine("## $cr")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Файл | Заголовок | Категория | Объём | Updated | Status | Source priority |")
    [void]$sb.AppendLine("|------|-----------|-----------|-------|---------|--------|-----------------|")

    foreach ($r in $group) {
        $relFromIndex = "../" + $r.Path
        $title = if ($r.Title) { $r.Title } else { "—" }
        $cat = if ($r.Category) { $r.Category } else { "—" }
        $chars = $r.Chars
        $upd = if ($r.Updated) { $r.Updated } else { "—" }
        $st = if ($r.Status) { $r.Status } else { "—" }
        $sp = if ($r.SourcePriority) { $r.SourcePriority } else { "—" }
        [void]$sb.AppendLine("| [$($r.Path)]($relFromIndex) | $title | $cat | $chars | $upd | $st | $sp |")
    }

    [void]$sb.AppendLine("")
}

[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Принципы")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("- Этот файл генерируется автоматически. Ручные правки будут перезаписаны.")
[void]$sb.AppendLine("- Источник правды — front matter в каждом документе.")
[void]$sb.AppendLine('- CI проверяет идемпотентность: запуск `tools/build-index.ps1` не должен давать diff между запусками.')

$newText = $sb.ToString() -replace "`r`n", "`n"
$todayUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$finalDate = $todayUtc
if (Test-Path -LiteralPath $outPath) {
    $existing = [System.IO.File]::ReadAllText($outPath)
    if ($existing -match '(?m)^updated:\s*"(\d{4}-\d{2}-\d{2})"') {
        $existingDate = $matches[1]
        if ($newText.Replace($updatedToken, $existingDate) -eq $existing) {
            $finalDate = $existingDate
        }
    }
}
$newText = $newText.Replace($updatedToken, $finalDate)

# Write file with UTF-8 (no BOM) and LF for cross-platform generated diffs.
[System.IO.File]::WriteAllText($outPath, $newText, [System.Text.UTF8Encoding]::new($false))

Write-Output ("Wrote {0} ({1} docs, {2} chars)" -f $Output, $totalDocs, $totalChars)

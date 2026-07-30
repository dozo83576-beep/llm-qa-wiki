param(
    [string]$Root = (Resolve-Path ".").Path,
    [switch]$FailOnWarnings,
    [int]$MinChars = 1200
)

$ErrorActionPreference = "Stop"

function Add-Warning {
    param(
        [System.Collections.Generic.List[string]]$Warnings,
        [string]$Message
    )
    $Warnings.Add($Message) | Out-Null
}

$rootPath = Resolve-Path -LiteralPath $Root
$warnings = [System.Collections.Generic.List[string]]::new()
$contentRoots = @(
    "docs/01-fundamentals",
    "docs/02-levels-and-types",
    "docs/03-test-design",
    "docs/04-documentation",
    "docs/05-defect-management",
    "docs/06-web-testing",
    "docs/07-mobile-testing",
    "docs/08-api-testing",
    "docs/09-automation",
    "docs/10-performance",
    "docs/11-security-accessibility",
    "docs/12-process-and-metrics",
    "docs/13-playbooks",
    "docs/14-templates",
    "checklists",
    "bug-taxonomy",
    "prompts",
    "case-studies",
    "lessons-learned",
    "resources"
)

$sectionQualityRoots = @(
    "docs/01-fundamentals",
    "docs/02-levels-and-types",
    "docs/03-test-design",
    "docs/04-documentation",
    "docs/05-defect-management",
    "docs/06-web-testing",
    "docs/07-mobile-testing",
    "docs/08-api-testing",
    "docs/09-automation",
    "docs/10-performance",
    "docs/11-security-accessibility",
    "docs/12-process-and-metrics",
    "docs/13-playbooks",
    "docs/14-templates"
)

$sectionPatterns = @(
    @{ Name = "usage"; Pattern = "(?im)^##\s+(Когда использовать|Когда применять|Шаги|Проверки|Что должно быть|Обязательные поля|Подходы|Уровни|Состав|Маршрут|Техника|Что покрывает)" },
    @{ Name = "avoid"; Pattern = "(?im)^##\s+(Когда не использовать|Когда не применять|Анти-паттерны|Stop conditions|Границы|Anti-patterns)" },
    @{ Name = "production"; Pattern = "(?im)^##\s+(Как это делается|Как применять|Правила|Порядок|Что обязательно проверить|Что проверять|Что измерять|Роли|Правила выставления|Инструменты|Главное правило|Практика)" },
    @{ Name = "mistakes"; Pattern = "(?im)^##\s+(Частые ошибки|Анти-паттерны|Риски|Ловушки|Anti-patterns)" },
    @{ Name = "verification"; Pattern = "(?im)^##\s+(Проверка|Как поймать|Проверки|Критерии приёмки|Доказательство|Evidence|CI-проверка)" },
    @{ Name = "sources"; Pattern = "(?im)(Источник|Источники|https?://|См\. \[)" }
)

# External authoritative sources that contradict source_priority: internal
$externalAuthoritative = @(
    "playwright\.dev",
    "docs\.cypress\.io",
    "selenium\.dev",
    "owasp\.org",
    "w3\.org/(WAI|TR/WCAG)",
    "istqb\.org",
    "iso\.org",
    "grafana\.com/docs/k6",
    "k6\.io/docs",
    "jmeter\.apache\.org",
    "developer\.mozilla\.org",
    "developer\.android\.com",
    "developer\.apple\.com",
    "learn\.microsoft\.com",
    "web\.dev",
    "developer\.chrome\.com",
    "swagger\.io/specification",
    "learning\.postman\.com",
    "pact\.io",
    "appium\.io"
)

$files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
foreach ($relativeRoot in $contentRoots) {
    $fullRoot = Join-Path $rootPath $relativeRoot
    if (Test-Path -LiteralPath $fullRoot) {
        Get-ChildItem -LiteralPath $fullRoot -Recurse -File |
            Where-Object { $_.Extension -in @(".md", ".mdx") } |
            ForEach-Object { $files.Add($_) | Out-Null }
    }
}

# Build a map of `updated` -> count to detect mass stamps
$updatedCounts = @{}
foreach ($file in $files) {
    $head = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -TotalCount 12 -ErrorAction SilentlyContinue
    foreach ($line in $head) {
        if ($line -match '^updated:\s*"?(\d{4}-\d{2}-\d{2})"?') {
            $d = $matches[1]
            if (-not $updatedCounts.ContainsKey($d)) { $updatedCounts[$d] = 0 }
            $updatedCounts[$d]++
        }
    }
}

foreach ($file in $files) {
    $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName
    $relativePath = Resolve-Path -LiteralPath $file.FullName -Relative

    # Skip redirect stubs (intentional thin docs)
    if ($content -match "(?im)^status:\s*[`"']?redirect") {
        continue
    }

    $normalizedRelative = $relativePath.TrimStart(".", "/", "\").Replace("\", "/")
    $isIndexLike = ($file.Name -eq "index.md") -or ($file.Name -like "_template*") -or ($file.Name -eq "source-priority.md") -or ($file.Name -eq "README.md")
    $isSectionQualityDoc = $false
    foreach ($root in $sectionQualityRoots) {
        if ($normalizedRelative.StartsWith($root + "/")) {
            $isSectionQualityDoc = $true
            break
        }
    }
    $isLegacyOrKnowledgeRoot = $normalizedRelative.StartsWith("bug-taxonomy/") -or
        $normalizedRelative.StartsWith("resources/") -or
        $normalizedRelative.StartsWith("case-studies/") -or
        $normalizedRelative.StartsWith("lessons-learned/")

    if (-not $isIndexLike -and $isSectionQualityDoc -and $content.Length -lt $MinChars) {
        Add-Warning $warnings ("Short production document: {0} ({1} chars, min {2})" -f $relativePath, $content.Length, $MinChars)
    }

    if (-not $isIndexLike -and $isLegacyOrKnowledgeRoot -and $content -notmatch "(?im)^status:\s*[`"']?(redirect|archived)" -and $content.Length -lt 700) {
        Add-Warning $warnings ("Short legacy/knowledge document should be expanded, redirected, or archived: {0} ({1} chars, min 700)" -f $relativePath, $content.Length)
    }

    if (-not $isIndexLike -and $isSectionQualityDoc) {
        $missingSections = [System.Collections.Generic.List[string]]::new()
        foreach ($section in $sectionPatterns) {
            if ($content -notmatch $section["Pattern"]) {
                $missingSections.Add($section["Name"]) | Out-Null
            }
        }
        # Allow up to 1 missing section out of 6 (occasional synonyms / structural variations)
        if ($missingSections.Count -gt 1) {
            Add-Warning $warnings ("Missing quality sections ({0}): {1}" -f ($missingSections -join ", "), $relativePath)
        }
    }

    # Rule: internal source_priority but external authoritative source linked.
    # Use source_priority: mixed when a doc combines internal practice with official references.
    # Skip the source-priority doc itself (it lists URLs as text examples, not citations)
    if (-not $isIndexLike -and $content -match '(?im)^source_priority:\s*"?internal"?') {
        foreach ($ext in $externalAuthoritative) {
            if ($content -match $ext) {
                Add-Warning $warnings ("source_priority 'internal' but cites external authoritative source ({0}): {1}" -f $ext, $relativePath)
                break
            }
        }
    }

    # Point-in-time record artifacts (case-studies, lessons-learned) carry a date in their
    # filename and legitimately keep an old `updated` stamp — exclude from freshness rules.
    # index/_template/README/source-priority are already covered by $isIndexLike.
    $isRecordArtifact = $normalizedRelative.StartsWith("case-studies/") -or $normalizedRelative.StartsWith("lessons-learned/")

    # Freshness rules: `updated` = content last changed; `reviewed` = last verified still-current.
    # Setting `reviewed: <today>` clears a stale-stamp warning honestly, without faking `updated`.
    if (-not $isIndexLike -and -not $isRecordArtifact -and $content -match '(?im)^updated:\s*"?(\d{4}-\d{2}-\d{2})"?') {
        $stampedDate = $matches[1]
        $stampCount = $updatedCounts[$stampedDate]

        $reviewedDate = $null
        if ($content -match '(?im)^reviewed:\s*"?(\d{4}-\d{2}-\d{2})"?') {
            try { $reviewedDate = [DateTime]::ParseExact($matches[1], "yyyy-MM-dd", $null) } catch { $reviewedDate = $null }
        }

        # Rule: stale updated stamp (mass-stamped + not reviewed/changed > 30 days)
        if ($stampCount -ge 30) {
            try {
                $lastCommitIso = (& git log -1 --format=%cs -- $file.FullName) 2>$null
                if ($lastCommitIso) {
                    $lastCommitDate = [DateTime]::ParseExact($lastCommitIso.Trim(), "yyyy-MM-dd", $null)
                    # Freshness = latest of (content change in git, explicit review)
                    $freshnessDate = $lastCommitDate
                    if ($reviewedDate -and $reviewedDate -gt $freshnessDate) { $freshnessDate = $reviewedDate }
                    $daysSince = (Get-Date).Subtract($freshnessDate).Days
                    if ($daysSince -gt 30) {
                        Add-Warning $warnings ("Stale updated stamp '{0}' (mass-shared by {1} files, not reviewed/changed {2} days): {3}" -f $stampedDate, $stampCount, $daysSince, $relativePath)
                    }
                }
            } catch {
                # git not available or file outside git — skip silently
            }
        }

        # Rule: updated/reviewed stamp vs git log skew > 14 days.
        # Compare against the LATER of updated/reviewed so a `reviewed`-only commit (git date moves
        # forward, `updated` intentionally stays) does not trip a false skew warning.
        try {
            $lastCommitIso = (& git log -1 --format=%cs -- $file.FullName) 2>$null
            if ($lastCommitIso) {
                $lastCommitDate = [DateTime]::ParseExact($lastCommitIso.Trim(), "yyyy-MM-dd", $null)
                $stamped = [DateTime]::ParseExact($stampedDate, "yyyy-MM-dd", $null)
                if ($reviewedDate -and $reviewedDate -gt $stamped) { $stamped = $reviewedDate }
                $skewDays = [Math]::Abs(($lastCommitDate - $stamped).Days)
                if ($skewDays -gt 14) {
                    Add-Warning $warnings ("updated/reviewed stamp differs from last git commit '{0}' by {1} days: {2}" -f $lastCommitIso.Trim(), $skewDays, $relativePath)
                }
            }
        } catch {
            # ignore
        }
    }
}

Write-Output "# Wiki quality report"
Write-Output ""
Write-Output ("- Checked production documents: {0}" -f $files.Count)
Write-Output ("- Min chars threshold: {0}" -f $MinChars)
Write-Output ("- Warnings: {0}" -f $warnings.Count)
Write-Output ""

if ($warnings.Count -gt 0) {
    Write-Output "## Warnings"
    Write-Output ""
    foreach ($warning in $warnings) {
        Write-Output ("- {0}" -f $warning)
    }
}
else {
    Write-Output "No quality warnings found."
}

if ($FailOnWarnings -and $warnings.Count -gt 0) {
    exit 1
}

exit 0

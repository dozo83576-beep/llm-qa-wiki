param(
    [string]$Title,
    [string]$FilePath,
    [string]$InputText,
    [string]$OutputPath = $env:GITHUB_STEP_SUMMARY
)

$ErrorActionPreference = "Stop"

if ($FilePath -and $InputText) {
    throw "Use either -FilePath or -InputText, not both."
}

$lines = [System.Collections.Generic.List[string]]::new()
if (-not [string]::IsNullOrWhiteSpace($Title)) {
    $lines.Add("## $Title") | Out-Null
    $lines.Add("") | Out-Null
}

if ($FilePath) {
    if (-not (Test-Path -LiteralPath $FilePath)) {
        throw "Summary file not found: $FilePath"
    }
    foreach ($line in Get-Content -LiteralPath $FilePath) {
        $lines.Add($line) | Out-Null
    }
}
elseif (-not [string]::IsNullOrEmpty($InputText)) {
    foreach ($line in ($InputText -split "\r?\n")) {
        $lines.Add($line) | Out-Null
    }
}
else {
    $stdin = [Console]::In.ReadToEnd()
    if (-not [string]::IsNullOrEmpty($stdin)) {
        foreach ($line in ($stdin -split "\r?\n")) {
            $lines.Add($line) | Out-Null
        }
    }
}

$summary = ($lines -join [Environment]::NewLine) + [Environment]::NewLine

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    Write-Output $summary
    exit 0
}

$summary | Out-File -FilePath $OutputPath -Encoding utf8 -Append

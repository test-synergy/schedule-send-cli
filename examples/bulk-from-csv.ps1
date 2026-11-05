# Массовая постановка писем в очередь Schedule Send CLI из CSV-таблицы.
#
# Пример запуска (из корня репозитория):
#   .\examples\bulk-from-csv.ps1 -Csv .\examples\clients.csv -Datetime "2026-11-01 09:00"
#
# Колонки CSV: email, subject, body, attachment (последняя может быть пустой).

param(
    [Parameter(Mandatory = $true)][string]$Csv,
    [Parameter(Mandatory = $true)][string]$Datetime,
    [string]$From = ""
)

$ErrorActionPreference = "Stop"

$sendJob = Join-Path (Split-Path $PSScriptRoot -Parent) "send_job.py"
if (-not (Test-Path $sendJob)) {
    throw "Не найден send_job.py рядом с папкой examples: $sendJob"
}

if (-not (Test-Path $Csv)) {
    throw "Не найден CSV-файл: $Csv"
}

$rows = Import-Csv -Path $Csv
if (-not $rows) {
    throw "В файле $Csv нет строк"
}

$ok = 0
$failed = 0

foreach ($row in $rows) {
    if (-not $row.email) {
        Write-Warning "Пропуск строки без email"
        $failed++
        continue
    }

    $jobArgs = @(
        $sendJob, "add",
        "--to", $row.email.Trim(),
        "--subject", $row.subject,
        "--body", $row.body,
        "--datetime", $Datetime
    )

    if ($row.attachment) {
        $jobArgs += @("--file", $row.attachment)
    }
    if ($From) {
        $jobArgs += @("--from", $From)
    }

    Write-Host "-> $($row.email)" -ForegroundColor Cyan
    python @jobArgs
    if ($LASTEXITCODE -eq 0) { $ok++ } else { $failed++ }
}

Write-Host ""
Write-Host "Готово: в очередь поставлено $ok, с ошибкой $failed" -ForegroundColor Green

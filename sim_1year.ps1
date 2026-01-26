$ErrorActionPreference="Stop"

# ===== CONFIG =====
$PROJECT="C:\Users\dj23\Desktop\DriverFlow\driverflow-mvp"
$SIM_DB="driverflow_year_sim.db"
$LOG_DIR="C:\DriverFlow\jobs\logs"
$LOG_FILE=Join-Path $LOG_DIR ("sim_1year_"+(Get-Date -Format "yyyyMMdd_HHmmss")+".log")

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
Set-Location $PROJECT

"=== SIM 1 YEAR START: $(Get-Date) ===" | Out-File $LOG_FILE -Encoding utf8
"PROJECT=$PROJECT" | Out-File $LOG_FILE -Append -Encoding utf8
"SIM_DB=$SIM_DB" | Out-File $LOG_FILE -Append -Encoding utf8

# ===== ENV =====
$env:SIM_TIME="1"
$env:SIM_TIME_SCALE="60"
$env:DB_PATH=$SIM_DB
$env:DRY_RUN="1"

# Clean start
if (Test-Path $SIM_DB) { Remove-Item $SIM_DB -Force }

"`n--- 1) MIGRATE ALL ---" | Out-File $LOG_FILE -Append -Encoding utf8
node migrate_all.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n--- 2) RESET SIM TIME ---" | Out-File $LOG_FILE -Append -Encoding utf8
node reset_sim_time.js 2030-01-01T00:00:00Z 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

function Get-WeekLabel {
  $out = node get_last_ticket_week.js 2>&1
  $s = ($out | Out-String).Trim()
  if ($s -match "BILLING_WEEK=") { return ($s -replace "BILLING_WEEK=","").Trim() }
  throw "Could not detect week label. Output was: $s"
}

function Run-Week($companyId) {
  "`n--- SEED company=$companyId ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node seed_weekly_tickets.js $companyId 1 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  $week = Get-WeekLabel
  "Detected Week: $week" | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- GENERATE invoices week=$week ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node generate_weekly_invoices.js $week 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- PROCESS outbox (DRY_RUN=1) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node process_outbox_emails.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
}

# ===== 52 WEEKS =====
for ($i=1; $i -le 52; $i++) {
  "`n==================== WEEK $i / 52 ====================" | Out-File $LOG_FILE -Append -Encoding utf8

  # Unique company id each week to avoid workflow constraints
  $companyId = 1000 + $i
  Run-Week $companyId

  "`n--- ADVANCE time 1 week ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node advance_time.js 1 week 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
}

"`n--- FINAL VERIFICATION ---" | Out-File $LOG_FILE -Append -Encoding utf8
node show_billing_counters.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node show_pending_invoice_events.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_events_status.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n=== SIM 1 YEAR DONE: $(Get-Date) ===" | Out-File $LOG_FILE -Append -Encoding utf8

Write-Host "DONE. Log saved at: $LOG_FILE"

$ErrorActionPreference="Stop"

# ===== CONFIG =====
$PROJECT="C:\Users\dj23\Desktop\DriverFlow\driverflow-mvp"
$SIM_DB="driverflow_3clients_sim.db"
$LOG_DIR="C:\DriverFlow\jobs\logs"
$LOG_FILE=Join-Path $LOG_DIR ("sim_3clients_"+(Get-Date -Format "yyyyMMdd_HHmmss")+".log")

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
Set-Location $PROJECT

"=== SIM 3 CLIENTS START: $(Get-Date) ===" | Out-File $LOG_FILE -Encoding utf8

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

# ===== CLIENTES =====
$A = 2001   # nunca paga
$B = 2002   # paga 1-3, no paga 4-9, paga TODO en 10
$C = 2003   # paga siempre

function Pay-All-Pending([int]$companyId) {
  for ($k=0; $k -lt 80; $k++) {
    $out = node pay_oldest_unpaid_invoice.js $companyId 2>&1
    ($out | Out-String) | Out-File $LOG_FILE -Append -Encoding utf8
    if (($out | Out-String) -match "No pending/overdue invoices found to pay") { break }
  }
}

"`n--- 3) SEED 12 WEEKS UPFRONT (A,B,C) ---" | Out-File $LOG_FILE -Append -Encoding utf8
node seed_weekly_tickets.js $A 12 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node seed_weekly_tickets.js $B 12 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node seed_weekly_tickets.js $C 12 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

# ===== 12 SEMANAS =====
for ($i=1; $i -le 12; $i++) {

  $weekLabel = "2030-" + ("{0:D2}" -f $i)
  "`n==================== WEEK $i / 12  (label=$weekLabel) ====================" | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- GENERATE invoices week=$weekLabel ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node generate_weekly_invoices.js $weekLabel 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- PROCESS outbox (DRY_RUN=1) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node process_outbox_emails.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  # ===== PAGOS =====
  "`n--- PAYMENTS ---" | Out-File $LOG_FILE -Append -Encoding utf8

  # Cliente A: nunca paga

  # Cliente B: paga semanas 1-3 (1 factura por semana), no paga 4-9, paga TODO en 10
  if ($i -ge 1 -and $i -le 3) {
    node pay_oldest_unpaid_invoice.js $B 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
  } elseif ($i -eq 10) {
    Pay-All-Pending $B
  }

  # Cliente C: paga siempre (1 por semana)
  node pay_oldest_unpaid_invoice.js $C 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- ADVANCE time 1 week ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node advance_time.js 1 week 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
}

"`n--- FINAL: DELINQUENCY CHECKS ---" | Out-File $LOG_FILE -Append -Encoding utf8
node check_delinquency.js $A 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_delinquency.js $B 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_delinquency.js $C 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n--- FINAL: GLOBAL COUNTERS ---" | Out-File $LOG_FILE -Append -Encoding utf8
node show_billing_counters.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_events_status.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n=== SIM 3 CLIENTS DONE: $(Get-Date) ===" | Out-File $LOG_FILE -Append -Encoding utf8
Write-Host "DONE. Log saved at: $LOG_FILE"

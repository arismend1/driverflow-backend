$ErrorActionPreference="Stop"

# ===== CONFIG =====
$PROJECT="C:\Users\dj23\Desktop\DriverFlow\driverflow-mvp"
$SIM_DB="driverflow_3clients_1year_sim.db"
$LOG_DIR="C:\DriverFlow\jobs\logs"
$LOG_FILE=Join-Path $LOG_DIR ("sim_3clients_1year_"+(Get-Date -Format "yyyyMMdd_HHmmss")+".log")

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
Set-Location $PROJECT

"=== SIM 3 CLIENTS 1 YEAR START: $(Get-Date) ===" | Out-File $LOG_FILE -Encoding utf8
"DB_PATH=$SIM_DB" | Out-File $LOG_FILE -Append -Encoding utf8

# ===== ENV =====
$env:SIM_TIME="1"
$env:SIM_TIME_SCALE="60"
$env:DB_PATH=$SIM_DB
$env:DRY_RUN="1"

# Clean start
if (Test-Path $SIM_DB) { Remove-Item $SIM_DB -Force }

"`n--- MIGRATE ALL ---" | Out-File $LOG_FILE -Append -Encoding utf8
node migrate_all.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n--- RESET SIM TIME ---" | Out-File $LOG_FILE -Append -Encoding utf8
node reset_sim_time.js 2030-01-01T00:00:00Z 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

# ===== CLIENTES =====
$A = 2001   # nunca paga
$B = 2002   # paga 1-3, no paga 4-9, paga TODO en 10, luego paga siempre
$C = 2003   # paga siempre

function Pay-All-Pending([int]$companyId) {
  for ($k=0; $k -lt 200; $k++) {
    $out = node pay_oldest_unpaid_invoice.js $companyId 2>&1
    ($out | Out-String) | Out-File $LOG_FILE -Append -Encoding utf8
    if (($out | Out-String) -match "No pending/overdue invoices found to pay") { break }
  }
}

# ===== 52 SEMANAS =====
for ($i=1; $i -le 52; $i++) {

  $weekLabel = "2030-" + ("{0:D2}" -f $i)
  "`n==================== WEEK $i / 52 (label=$weekLabel) ====================" | Out-File $LOG_FILE -Append -Encoding utf8

  # 1) SEMBRAR 1 ticket por cliente (siempre). El bloqueo real debe impedir facturas, NO la siembra.
  "`n--- SEED A=$A (never pay) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node seed_weekly_tickets.js $A 1 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- SEED B=$B ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node seed_weekly_tickets.js $B 1 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  "`n--- SEED C=$C (always pay) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node seed_weekly_tickets.js $C 1 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  # 2) GENERAR FACTURAS (debe saltar empresas bloqueadas)
  "`n--- GENERATE invoices week=$weekLabel ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node generate_weekly_invoices.js $weekLabel 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  # 3) PROCESAR OUTBOX (DRY_RUN)
  "`n--- PROCESS outbox (DRY_RUN=1) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node process_outbox_emails.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  # 4) PAGOS SEGUN REGLAS
  "`n--- PAYMENTS ---" | Out-File $LOG_FILE -Append -Encoding utf8

  # A: nunca paga

  # B: paga 1-3, no paga 4-9, paga TODO en 10, luego paga siempre 1 por semana
  if ($i -ge 1 -and $i -le 3) {
    node pay_oldest_unpaid_invoice.js $B 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
  } elseif ($i -ge 4 -and $i -le 9) {
    # no paga
  } elseif ($i -eq 10) {
    Pay-All-Pending $B
  } else {
    node pay_oldest_unpaid_invoice.js $B 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
  }

  # C: paga siempre (1 por semana)
  node pay_oldest_unpaid_invoice.js $C 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  # 5) OUTBOX otra vez (para marcar invoice_paid como sent si tu process_outbox ya lo hace; si no, igual queda registrado)
  "`n--- PROCESS outbox AFTER PAYMENTS (DRY_RUN=1) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node process_outbox_emails.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

  # 6) AVANZAR 1 SEMANA
  "`n--- ADVANCE time 1 week ---" | Out-File $LOG_FILE -Append -Encoding utf8
  node advance_time.js 1 week 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
}

# ===== FIX OUTBOX invoice_paid (por si quedaron pendientes/failed) =====
"`n--- FINAL: NORMALIZE invoice_paid in outbox (mark as sent) ---" | Out-File $LOG_FILE -Append -Encoding utf8
if (Test-Path ".\fix_outbox_paid.js") {
  node fix_outbox_paid.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
} else {
  "fix_outbox_paid.js not found, skipping." | Out-File $LOG_FILE -Append -Encoding utf8
}

# ===== RESUMEN FINAL =====
"`n--- FINAL: DELINQUENCY CHECKS ---" | Out-File $LOG_FILE -Append -Encoding utf8
node check_delinquency.js $A 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_delinquency.js $B 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_delinquency.js $C 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n--- FINAL: GLOBAL COUNTERS ---" | Out-File $LOG_FILE -Append -Encoding utf8
node show_billing_counters.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node check_events_status.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
node show_pending_invoice_events.js 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8

"`n=== SIM 3 CLIENTS 1 YEAR DONE: $(Get-Date) ===" | Out-File $LOG_FILE -Append -Encoding utf8
Write-Host "DONE. Log saved at: $LOG_FILE"

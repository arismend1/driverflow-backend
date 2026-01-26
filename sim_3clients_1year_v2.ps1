$ErrorActionPreference="Stop"

$PROJECT="C:\Users\dj23\Desktop\DriverFlow\driverflow-mvp"
$SIM_DB="driverflow_3clients_1year_sim_v2.db"
$LOG_DIR="C:\DriverFlow\jobs\logs"
$LOG_FILE=Join-Path $LOG_DIR ("sim_3clients_1year_v2_"+(Get-Date -Format "yyyyMMdd_HHmmss")+".log")

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
Set-Location $PROJECT

"=== SIM 3 CLIENTS 1 YEAR V2 START: $(Get-Date) ===" | Out-File $LOG_FILE -Encoding utf8

$env:SIM_TIME="1"
$env:SIM_TIME_SCALE="60"
$env:DB_PATH=$SIM_DB
$env:DRY_RUN="1"

if (Test-Path $SIM_DB) { Remove-Item $SIM_DB -Force }

function Run-Node([string]$args) {
  # Ejecuta node via cmd para que PowerShell NO trate stderr como error
  cmd /c "node $args >> `"$LOG_FILE`" 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "Node failed: node $args (exit=$LASTEXITCODE). See log: $LOG_FILE" }
}

# Helper: estado bloqueado desde DB (sin node -e)
@"
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH, { readonly: true });
const companyId = Number(process.argv[2]);
const row = db.prepare('SELECT is_blocked, blocked_reason FROM empresas WHERE id=?').get(companyId);
console.log({ companyId, is_blocked: row ? row.is_blocked : null, blocked_reason: row ? row.blocked_reason : null });
"@ | Set-Content ".\check_company_status.js" -Encoding UTF8

function Is-Blocked([int]$companyId) {
  $out = cmd /c "node check_company_status.js $companyId"
  $out | Out-File $LOG_FILE -Append -Encoding utf8
  return ($out -match "is_blocked:\s*1")
}

function Pay-All-Pending([int]$companyId) {
  for ($k=0; $k -lt 300; $k++) {
    $out = cmd /c "node pay_oldest_unpaid_invoice.js $companyId"
    $out | Out-File $LOG_FILE -Append -Encoding utf8
    if ($out -match "No pending/overdue invoices found to pay") { break }
  }
  Run-Node "check_delinquency.js $companyId"
}

# Clientes
$A = 2001
$B = 2002
$C = 2003

"--- MIGRATE ALL ---" | Out-File $LOG_FILE -Append -Encoding utf8
Run-Node "migrate_all.js"

"--- RESET SIM TIME ---" | Out-File $LOG_FILE -Append -Encoding utf8
Run-Node "reset_sim_time.js 2030-01-01T00:00:00Z"

for ($i=1; $i -le 52; $i++) {
  $weekLabel = "2030-" + ("{0:D2}" -f $i)
  "==================== WEEK $i / 52 (label=$weekLabel) ====================" | Out-File $LOG_FILE -Append -Encoding utf8

  "--- SEED WEEK (only if NOT blocked) ---" | Out-File $LOG_FILE -Append -Encoding utf8

  if (-not (Is-Blocked $A)) { Run-Node "seed_weekly_tickets.js $A 1" } else { "A blocked -> no tickets" | Out-File $LOG_FILE -Append -Encoding utf8 }
  if (-not (Is-Blocked $B)) { Run-Node "seed_weekly_tickets.js $B 1" } else { "B blocked -> no tickets" | Out-File $LOG_FILE -Append -Encoding utf8 }
  if (-not (Is-Blocked $C)) { Run-Node "seed_weekly_tickets.js $C 1" } else { "C blocked -> no tickets" | Out-File $LOG_FILE -Append -Encoding utf8 }

  "--- GENERATE invoices week=$weekLabel ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Run-Node "generate_weekly_invoices.js $weekLabel"

  "--- PROCESS outbox ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Run-Node "process_outbox_emails.js"

  "--- PAYMENTS ---" | Out-File $LOG_FILE -Append -Encoding utf8
  # A: nunca paga

  # B: paga 1-3, no paga 4-9, paga TODO en 10
  if ($i -ge 1 -and $i -le 3) {
    Run-Node "pay_oldest_unpaid_invoice.js $B"
    Run-Node "check_delinquency.js $B"
  } elseif ($i -eq 10) {
    Pay-All-Pending $B
  }

  # C: paga siempre
  Run-Node "pay_oldest_unpaid_invoice.js $C"
  Run-Node "check_delinquency.js $C"

  "--- ADVANCE time 1 week ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Run-Node "advance_time.js 1 week"
}

"--- FINAL: CHECKS ---" | Out-File $LOG_FILE -Append -Encoding utf8
Run-Node "check_delinquency.js $A"
Run-Node "check_delinquency.js $B"
Run-Node "check_delinquency.js $C"
Run-Node "show_billing_counters.js"
Run-Node "check_events_status.js"

"=== SIM DONE: $(Get-Date) ===" | Out-File $LOG_FILE -Append -Encoding utf8
Write-Host "DONE. Log saved at: $LOG_FILE"

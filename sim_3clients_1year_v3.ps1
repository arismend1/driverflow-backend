$ErrorActionPreference = "Stop"

# ===== CONFIG =====
$PROJECT = "C:\Users\dj23\Desktop\DriverFlow\driverflow-mvp"
$DEFAULT_DB_PATH = "driverflow_5clients_1year_sim.db"
$LOG_DIR = "C:\DriverFlow\jobs\logs"
$LOG_FILE = Join-Path $LOG_DIR ("sim_5clients_1year_v3_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".log")

New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
Set-Location $PROJECT

"=== SIM 5 CLIENTS 1 YEAR START: $(Get-Date) ===" | Out-File $LOG_FILE -Encoding utf8

# Helper to run node and check exit code
function Invoke-NodeScript([string]$cmd) {
  Invoke-Expression "node $cmd" 2>&1 | Out-File $LOG_FILE -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) {
    $msg = "FATAL: Command failed with exit code $LASTEXITCODE : node $cmd"
    "ERROR: $msg" | Out-File $LOG_FILE -Append -Encoding utf8
    Write-Error $msg
  }
}

# ===== DB PATH PROTECTION & LOGIC =====
$ALLOW_EXTERNAL = $env:ALLOW_EXTERNAL_DB
"ALLOW_EXTERNAL_DB=$ALLOW_EXTERNAL" | Out-File $LOG_FILE -Append -Encoding utf8

if ($ALLOW_EXTERNAL -eq "1" -and $env:DB_PATH) {
  "Using EXTERNAL DB_PATH logic enabled per ALLOW_EXTERNAL_DB=1." | Out-File $LOG_FILE -Append -Encoding utf8
}
else {
  $env:DB_PATH = $DEFAULT_DB_PATH
  "Enforcing DEFAULT DB_PATH (Deterministic Mode): $env:DB_PATH" | Out-File $LOG_FILE -Append -Encoding utf8
}

# SAFETY GUARD: ANTI-PROD
if ($env:DB_PATH -like "*driverflow_prod.db*" -or $env:DB_PATH -like "*\DriverFlow\data\*") {
  $msg = "ABORT: DB_PATH points to PRODUCTION or DATA folder. Path: $env:DB_PATH. Clean DB_PATH or use a simulation DB."
  "ERROR: $msg" | Out-File $LOG_FILE -Append -Encoding utf8
  Write-Error $msg
  exit 1
}

$EFFECTIVE_DB_PATH = $env:DB_PATH
"EFFECTIVE_DB_PATH=$EFFECTIVE_DB_PATH" | Out-File $LOG_FILE -Append -Encoding utf8
Write-Host "EFFECTIVE_DB_PATH=$EFFECTIVE_DB_PATH"

# ===== OTHER ENV =====
$env:SIM_TIME = "1"
$env:SIM_TIME_SCALE = "60"
$env:DRY_RUN = "1"
$env:ALLOW_BLOCKED = "0" # STRICT ENFORCEMENT

# Clean start
if (Test-Path $EFFECTIVE_DB_PATH) { 
  Remove-Item $EFFECTIVE_DB_PATH -Force 
  "Removed old DB at $EFFECTIVE_DB_PATH" | Out-File $LOG_FILE -Append -Encoding utf8
}

"`n--- MIGRATE ALL ---" | Out-File $LOG_FILE -Append -Encoding utf8
Invoke-NodeScript "migrate_all.js"

"`n--- RESET SIM TIME ---" | Out-File $LOG_FILE -Append -Encoding utf8
Invoke-NodeScript "reset_sim_time.js 2030-01-01T00:00:00Z"

# ===== CLIENTES =====
$C2001 = 2001
$C2002 = 2002
$C2003 = 2003
$C2004 = 2004
$C2005 = 2005

function Invoke-PaymentCycle([int]$companyId, $full = $false) {
  if ($full) {
    # Attempt to pay multiple times to clear backlog
    for ($k = 0; $k -lt 300; $k++) {
      Invoke-NodeScript "pay_oldest_unpaid_invoice.js $companyId"
    }
  }
  else {
    Invoke-NodeScript "pay_oldest_unpaid_invoice.js $companyId"
  }
}

# ===== 52 SEMANAS =====
for ($i = 1; $i -le 52; $i++) {
  $weekLabel = "2030-" + ("{0:D2}" -f $i)
  "`n==================== WEEK $i / 52 (label=$weekLabel) ====================" | Out-File $LOG_FILE -Append -Encoding utf8

  # 1. SEED TICKETS (GENERACION)
  "`n--- 1. SEED TICKETS ($weekLabel) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  
  # 2001: Activa 1-52
  Invoke-NodeScript "seed_weekly_tickets.js $C2001 1"

  # 2002: Activa 1-26
  if ($i -le 26) { Invoke-NodeScript "seed_weekly_tickets.js $C2002 1" }

  # 2003: Activa 27-52
  if ($i -ge 27) { Invoke-NodeScript "seed_weekly_tickets.js $C2003 1" }

  # 2004: Activa 1-52
  Invoke-NodeScript "seed_weekly_tickets.js $C2004 1"

  # 2005: Activa 1-17 Y 40-52
  if ($i -le 17 -or $i -ge 40) { Invoke-NodeScript "seed_weekly_tickets.js $C2005 1" }


  # 2. GENERATE INVOICES
  "`n--- 2. GENERATE INVOICES ($weekLabel) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Invoke-NodeScript "generate_weekly_invoices.js $weekLabel"

  # 3. PROCESS OUTBOX (SEND INVOICES)
  "`n--- 3. PROCESS OUTBOX (Emails) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Invoke-NodeScript "process_outbox_emails.js"

  # 4. PAYMENTS
  "`n--- 4. PAYMENTS ---" | Out-File $LOG_FILE -Append -Encoding utf8

  # --- 2001: Paga puntual siempre
  Invoke-PaymentCycle $C2001

  # --- 2002: Paga puntual 1-26
  if ($i -le 26) { Invoke-PaymentCycle $C2002 }

  # --- 2003: Paga puntual 27-52
  if ($i -ge 27) { Invoke-PaymentCycle $C2003 }

  # --- 2004: 
  # Paga 1-22
  # NO paga 23-45
  # Paga TODO 46
  # Paga 47-52
  if ($i -le 22) {
    Invoke-PaymentCycle $C2004
  }
  elseif ($i -ge 23 -and $i -le 45) {
    # No payment
  }
  elseif ($i -eq 46) {
    Invoke-PaymentCycle $C2004 -full $true
  }
  elseif ($i -ge 47) {
    Invoke-PaymentCycle $C2004
  }

  # --- 2005:
  # Paga 1-9
  # NO paga 10-17
  # Inactiva 18-39 (No paga)
  # Activa 40-52
  # Paga TODO 40
  # Paga 41-52
  if ($i -le 9) {
    Invoke-PaymentCycle $C2005
  }
  elseif ($i -ge 10 -and $i -le 39) {
    # No Payment
  }
  elseif ($i -eq 40) {
    Invoke-PaymentCycle $C2005 -full $true
  }
  elseif ($i -ge 41) {
    Invoke-PaymentCycle $C2005
  }


  # 5. PROCESS OUTBOX (RECEIPTS)
  "`n--- 5. PROCESS OUTBOX (Receipts) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Invoke-NodeScript "process_outbox_emails.js"

  # 6. ADVANCE TIME
  "`n--- 6. ADVANCE TIME (1 Week) ---" | Out-File $LOG_FILE -Append -Encoding utf8
  Invoke-NodeScript "advance_time.js 1 week"
}

"`n--- FINAL: DELINQUENCY CHECKS ---" | Out-File $LOG_FILE -Append -Encoding utf8
Invoke-NodeScript "check_delinquency.js $C2001"
Invoke-NodeScript "check_delinquency.js $C2002"
Invoke-NodeScript "check_delinquency.js $C2003"
Invoke-NodeScript "check_delinquency.js $C2004"
Invoke-NodeScript "check_delinquency.js $C2005"

"`n--- FINAL: GLOBAL COUNTERS ---" | Out-File $LOG_FILE -Append -Encoding utf8
Invoke-NodeScript "show_billing_counters.js"

"`n=== SIM DONE ===" | Out-File $LOG_FILE -Append -Encoding utf8
Write-Host "DONE. Log: $LOG_FILE"

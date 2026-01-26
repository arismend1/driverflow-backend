# safe_shell.ps1
# Clears dangerous variables and runs migrations in DEV mode with safe defaults.

Write-Host "--- SAFE MIGRATION SHELL ---" -ForegroundColor Cyan

# 1. Clear dangerous variables
Remove-Item Env:DB_PATH -ErrorAction SilentlyContinue
Remove-Item Env:ALLOW_PROD_MIGRATIONS -ErrorAction SilentlyContinue
$env:NODE_ENV = "development"

Write-Host "Cleared DB_PATH and ALLOW_PROD_MIGRATIONS."
Write-Host "Set NODE_ENV=development."

# 2. Run Migration
# This will trigger the Safe Default logic in migrate_all.js (creating/using driverflow_dev.db)
Write-Host "Running migrate_all.js..." -ForegroundColor Yellow
node migrate_all.js

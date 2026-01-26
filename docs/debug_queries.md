# Debugging Queries in PowerShell

Often, complex SQL queries (especially those with `*` or quotes) fail when executed directly with `node -e` inside PowerShell due to argument parsing rules.

To solve this, use the helper scripts in `scripts/`.

## 1. Setup DB Context
Always define the DB path first:

```powershell
$env:DB_PATH="driverflow_3clients_1year_sim.db"
```

## 2. Tickets By Week
Instead of writing the SQL, run:

```powershell
node scripts/tickets_by_week.js 2002
```

## 3. Generic SQL
For ad-hoc queries, pass the SQL string (quotes are safer here than in `-e`):

```powershell
node scripts/sql_query.js "SELECT * FROM tickets LIMIT 5"
```

## Safety Note
These scripts will **ABORT** if you attempt to run them against the PRODUCTION database (`driverflow_prod.db`).

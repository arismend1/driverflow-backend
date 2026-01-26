# Operational Runbook – DRY_RUN Week (Go-Live Controlled)

**Objective**: Validate billing and email logic consistency without sending real emails or collecting real payments.
**Duration**: 7 Days (Mon–Sun)
**Mode**: `DRY_RUN=1` (Strictly Enforced)

---

## 🛑 NON-NEGOTIABLE RULES
1.  **NEVER** unset `DRY_RUN` variable during this week.
2.  **NO** manual database edits unless part of a rollback.
3.  **NO** code changes. Freeze is active.
4.  **ALWAYS** backup database before Monday generation run.

---

## A) Daily Routine

### 1. Daily Health Check (Mon-Sun)
-   **System**: Ensure backend is running.
    ```powershell
    # Check if process is running (adapt if using pm2 or similar)
    tasklist | findstr "node"
    ```
-   **Database Access**: Verify DB is readable.
    ```powershell
    node -e "const db=require('better-sqlite3')('driverflow.db'); console.log('DB OK, Drivers:', db.prepare('SELECT count(*) as c FROM drivers').get().c);"
    ```
-   **New Tickets**: Count tickets created in last 24h.
    ```powershell
    node -e "const db=require('better-sqlite3')('driverflow.db'); console.log('New Tickets (24h):', db.prepare(\"SELECT count(*) as c FROM tickets WHERE created_at > datetime('now', '-1 day')\").get().c);"
    ```

### 2. Monday Billing Run (Monday Only)
**Pre-Requisite**: Week cycle has completed (Monday 00:00).

1.  **Backup Database**:
    ```powershell
    node backup_db.js
    ```
    *Verify backup file created in `backups/` timestamped folders.*

2.  **Generate Invoices**:
    ```powershell
    # Determine target week string (e.g., '2026-03' for 3rd week of 2026)
    # If running for "Last Week", provide that string manually or let script default if running on Monday morning for previous week.
    node generate_weekly_invoices.js <OPTIONAL_YYYY_WW>
    ```

3.  **Verify Integrity**:
    Run the following query check script (create `check_integrity.js` temporarily or run via `node -e`):
    ```javascript
    const db = require('better-sqlite3')('driverflow.db');
    const invoices = db.prepare("SELECT * FROM invoices WHERE status='pending'").all();
    console.log(`Invoices Created: ${invoices.length}`);
    invoices.forEach(inv => {
        const items = db.prepare("SELECT sum(price_cents) as s, count(*) as c FROM invoice_items WHERE invoice_id=?").get(inv.id);
        const match = (items.s === inv.subtotal_cents) && (items.s === inv.total_cents);
        console.log(`Invoice ${inv.id}: Items=${items.c}, Subtotal=${inv.subtotal_cents/100} USD. MATCH=${match}`);
        if(!match) console.error("!!! FATAL: TOTALS MISMATCH !!!");
    });
    ```

4.  **Verify Outbox Generation**:
    ```powershell
    node -e "const db=require('better-sqlite3')('driverflow.db'); console.log('Pending Emails:', db.prepare(\"SELECT count(*) as c FROM events_outbox WHERE event_name='invoice_generated' AND process_status='pending'\").get().c);"
    ```

5.  **Run Email Processor (DRY RUN)**:
    ```powershell
    # Windows PowerShell
    $env:DRY_RUN="1"; $env:SENDGRID_API_KEY="placeholder_key"; node process_outbox_emails.js
    ```
    **Expected Output**:
    -   `[DRY_RUN] Would send email to...`
    -   Payload contains correct: Invoice ID, Billing Week, Ticket Count, Total Due.
    -   `✅ Event X processed successfully.`

6.  **Verify Final State**:
    -   Events should now be status `sent` (simulated).
    -   Verify NO pending events remain.
    ```powershell
    node -e "const db=require('better-sqlite3')('driverflow.db'); console.log('Remaining Pending:', db.prepare(\"SELECT count(*) as c FROM events_outbox WHERE event_name='invoice_generated' AND process_status='pending'\").get().c);"
    ```

---

## B) Metrics Log Table

| Date       | Activity            | new_tickets | invoices_created | total_billed_cents | pending_events_start | processed_dry_run | errors | Operator Initials |
| :---       | :---                | :---:       | :---:            | :---:              | :---:                | :---:             | :---:  | :---:             |
| 2026-01-19 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-20 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-21 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-22 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-23 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-24 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-25 | Checks Only         |             | -                | -                  |                      | -                 |        |                   |
| 2026-01-26 | **MONDAY BILLING**  |             | **[COUNT]**      | **[CENTS]**        | **[COUNT]**          | **[COUNT]**       |        |                   |

---

## C) Acceptance Criteria (End of Week)
1.  **Reconciliation**: Total sum of all tickets for the week == Total sum of all invoices == Total sum reported in email payloads.
2.  **Idempotency**: Rerunning `generate_weekly_invoices.js` on Tuesday produces **0** new invoices and **0** duplicates.
3.  **Process Logic**: `process_outbox_emails.js` in DRY_RUN correctly updates DB status to `sent` but sends 0 actual emails.
4.  **Stability**: No server crashes or unhandled exceptions in scripts.

---

## D) Critical Defects Procedures
**Definition of Critical Defect**:
-   Ticket billed but not linked to invoice.
-   Invoice created with 0 items but `subtotal > 0` (or vice versa).
-   Duplicate `invoice_items` for the same `ticket_id`.
-   Double processing of same event.
-   Data loss.

**Immediate Action**:
1.  **Stop Operation**: Do not run any further scripts.
2.  **Log Evidence**: Copy-paste terminal output affecting the defect.
3.  **Analyze**: Determine if DB is corrupted.
4.  **Report**: Notify Engineering Lead immediately.

---

## E) Rollback & Recovery
**Scenario**: Monday generation creates corrupt data (e.g., mismatch totals).

1.  **Identify Backup**: Locate the backup file created in Step A.2.1 (e.g., `backups/driverflow_backup_YYYY-MM-DD_HH-MM-SS.db`).
2.  **Stop Server**: Ensure no incoming requests are writing.
3.  **Restore**:
    ```powershell
    # Copy backup to main DB location (Be careful!)
    node restore_db.js <path_to_backup_file>
    ```
4.  **Verify**: Run Health Check (A.1) to confirm DB is reachable and state is pre-corruption.

---

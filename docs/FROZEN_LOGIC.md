# Frozen Logic Policy

**STATUS: ACTIVE**
**CRITICALITY: HIGH**

The following files contain the core business logic for delinquency, blocking, and billing. They have been validated against strict business rules and must NOT be modified without following the overriding procedure.

## Frozen Files
- `delinquency.js`
- `generate_weekly_invoices.js`
- `process_outbox_emails.js`
- `check_delinquency.js`

## Why are they frozen?
These files enforce the "Zero Tolerance" policy for delinquency:
1.  **Blocking**: Automatic block at >= 4 overdue invoices.
2.  **Safety**: No new invoices generated for blocked companies.
3.  **Data Integrity**: `nowIso()` usage for all time calculations.
4.  **Audit**: Event handling clean-up (invoice_paid marked as sent).

Any regression here could cause infinite debt accumulation or false blocking.

## Modification Procedure (Override)

To modify these files, you MUST follow this strict process:

1.  **Justification**: Open an issue explaining *why* the frozen logic is incorrect or insufficient. Optimization/Refactoring is NOT a valid reason.
2.  **Pull Request**:
    *   Create a PR with your changes.
    *   **MANDATORY**: Include `[OVERRIDE-FROZEN]` in the PR title. The CI build will fail otherwise.
3.  **Verification**:
    *   You must attach a simulation log of **1 year with 3 clients** (1 payer, 1 partial payer, 1 non-payer).
    *   Confirm that the non-payer stops receiving invoices exactly at the threshold (4 pending).
4.  **Approval**:
    *   Requires approval from a designated **CODEOWNER**.
    *   Requires all CI checks to pass.

## Local Development
To prevents accidental edits locally, mark these files as read-only:

**Windows (PowerShell):**
```powershell
attrib +R delinquency.js
attrib +R generate_weekly_invoices.js
attrib +R process_outbox_emails.js
attrib +R check_delinquency.js
```

**Linux/Mac:**
```bash
chmod -w delinquency.js generate_weekly_invoices.js process_outbox_emails.js check_delinquency.js
```

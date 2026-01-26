# Strict Security & Payment Assurance Implementation

This document details the implementation of the strict security requirements for the DriverFlow backend. All logic has been verified via the `verify_safety_prompt_law.js` regression suite.

## 1. Contact Reveal Guard (Strict Payment)
**Requirement**: Contact details revealed ONLY after mutual acceptance AND paid ticket.
- **Implementation**: `GET /request/:id/contact` (server.js)
- **Logic**:
    1.  **Auth Check**: `reqInfo.empresa_id` or `driver_id` must match user.
    2.  **State Check**: Request must be `ACEPTADA`, `FINALIZADA`, or `CANCELADA`.
    3.  **Payment Check**: SQL Query joins `tickets` -> `invoice_items` -> `invoices`.
        -   Start Guard: `invoice.status === 'paid'` AND `paid_at IS NOT NULL`.
        -   If not paid -> Returns `402 Payment Required`.
    4.  **Operational Check**: Calls `enforceCompanyCanOperate` to ensure company isn't currently blocked.

## 2. Ticket Generation
**Requirement**: Billable ticket generated ONLY upon Company approval.
- **Implementation**: `POST /approve_driver` (server.js)
- **Logic**:
    -   Transactionally updates Request to `ACEPTADA`.
    -   Immediately inserts row into `tickets` table with `billing_status='unbilled'`.
    -   This is the *only* entry point for ticket creation in the matching flow.

## 3. Void & Locked Contact
**Requirement**: Locked if ticket voided.
- **Implementation**: `GET /request/:id/contact`
- **Logic**: The query explicitly filters `AND t.billing_status != 'void'`.
    -   If a ticket is voided, the query returns no record.
    -   Result: Access Denied (403/402).

## 4. Operational Blocking (Delinquency)
**Requirement**: Blocked companies denied value-creating actions.
- **Implementation**: `enforceCompanyCanOperate` (access_control.js)
- **Logic**:
    -   Checks `empresas.is_blocked`.
    -   Calculates overdue debt (> 28 days).
    -   Throws `ACCOUNT_BLOCKED_OVERDUE_INVOICES` (403).
-   **Guards Applied To**:
    -   `POST /create_request`
    -   `POST /apply_for_request` (Prevents driver from wasting time applying to bad debt companies)
    -   `POST /approve_driver`

## 5. Admin Void with Credit Note
**Requirement**: Voiding paid ticket issues Credit Note + Audit Log.
- **Implementation**: `POST /admin/tickets/void` (server.js)
- **Logic**:
    1.  Checks Admin Secret.
    2.  Check Ticket Status.
    3.  If associated Invoice is `paid`:
        -   Insert `credit_notes` record (Refund).
        -   Log "Credit Note Issued".
    4.  Update Ticket `billing_status = 'void'`.
    5.  Insert `audit_logs` record (Action: `void_ticket`).

## 6. Secure Webhooks
**Requirement**: Idempotent, secure, amount validation.
- **Implementation**: `POST /webhooks/payment` (server.js)
- **Logic**:
    1.  **Signature**: Checks `x-webhook-secret`.
    2.  **Idempotency**: Checks `webhook_events` table for (`event_id`). Returns success if already processed.
    3.  **Amount**: Validates `amount_paid` matches invoice total.
    4.  **Effect**: Updates Invoice -> `paid`.
    5.  **Auto-Unlock**: Calls `enforceCompanyCanOperate` to lift block if debts are cleared.

## 7. Prevention of Unauthorized Access
**Requirement**: Prevent duplicates, fake payments, authorized access.
- **Implementation**:
    -   **Auth**: `authenticateToken` middleware on all endpoints.
    -   **Context**: All queries include `company_id = ?` or `driver_id = ?` checks.
    -   **Transactions**: Critical flows (`approve`, `webhook`, `void`) wrap all DB writes in `db.transaction()` to ensure atomicity.

## Verification
Run the regression suite to prove compliance:
```powershell
node verify_safety_prompt_law.js
```
**Status**: ✅ ALL PROMPT LAW REQUIREMENTS VERIFIED

# PRODUCT_UX_STATES.md

## 1. PLATFORM ROLE DEFINITIONS
- **Company**: Business entity seeking to connect with drivers.
- **Driver**: Commercial driver seeking connections with companies.
- **Admin**: Platform administrator with override capabilities.
- **System**: Automated processes (matching, billing triggers, blocking).

## 2. CORE ENTITIES & STATES

### Company
- **REGISTERED**: Account created, email not yet verified.
- **ACTIVE**: Email verified, full platform access.
- **BLOCKED**: Access restricted due to non-payment or violation.
- **SEARCH_ON**: actively looking for matches.
- **SEARCH_OFF**: Not looking for matches.

### Driver
- **REGISTERED**: Account created.
- **ACTIVE**: Profile complete and validated.
- **SUSPENDED**: Account disabled by Admin.
- **SEARCH_ON**: Available for matching.
- **SEARCH_OFF**: Unavailable for matching.

### Request (Job Post)
- **CREATED**: Draft state.
- **OPEN**: Active in the marketplace.
- **IN_REVIEW**: Flagged for admin review.
- **APPROVED**: Validated and live.
- **CLOSED**: Removed from marketplace (filled or cancelled).

### Match
- **VISIBLE**: Company sees anonymous driver profile (blind match).
- **APPLIED**: Driver has applied to request.
- **APPROVED**: Company has accepted the driver.
- **REJECTED**: Company has declined the driver.

### Ticket / Billing
- **CREATED**: Billable event occurred (Match Approval).
- **INVOICED**: Formal invoice generated for the ticket.
- **PAID**: Payment successfully processed.
- **VOID**: Ticket cancelled before payment (no debt).
- **CREDIT_NOTE_ISSUED**: Refund or adjustment applied after payment.

## 3. UX FLOW — COMPANY
- **Registration**: Company creates account.
- **Setup**: Company completes match questionnaire.
- **Activation**: Company turns search **ON**.
- **Discovery**: Company receives match notifications.
    - *View*: Driver details are **Anonymous**.
- **Action**: Company **Approves** a driver.
- **Trigger**: System generates a **Ticket** immediately upon approval.
- **Gate**: Contact details remain **LOCKED**.
- **Payment**: Company pays the generated Ticket.
- **Result**: Contact details are **REVEALED**.
- **Enforcement**: If Ticket is not paid within window, Company state -> **BLOCKED**.

## 4. UX FLOW — DRIVER
- **Registration**: Driver creates account.
- **Setup**: Driver completes profile.
- **Activation**: Driver turns search **ON**.
- **Discovery**: Driver receives match notifications.
- **Action**: Driver applies to Company (or accepts match).
- **Wait**: Company contact info is **HIDDEN**.
- **Trigger**: Company **Approves** + **Pays**.
- **Result**: Company contact info **REVEALED** to Driver.

## 5. PAYMENT & ACCESS RULES
- **No Payment → No Contact**: Absolute rule. Contact reveal is strictly gated by `ticket_status: PAID`.
- **Approval Alone ≠ Access**: Approval creates the *obligation* (Ticket) but does not grant *access*.
- **Ticket Generation**: Occurs automatically when Company status changes Match to `APPROVED`.
- **Voiding**: A `VOID` ticket cancels the debt but never unlocks the contact.

## 6. ADMIN ACTIONS
- **Void Ticket**: Admin can void a customized ticket if created in error.
- **Issue Credit Note**: Admin issues credit note for PAID tickets if refund is authorized (e.g., verified fraud).
- **Audit**: All high-impact actions (Void, Block, Suspend) are logged.
- **Suspend**: Admin can manually set Company or Driver to SUSPENDED/BLOCKED.

## 7. LEGAL TRIGGERS
- **Service Delivery**: The exact moment contact information is revealed (`contact_reveal: true`).
- **Payment Obligation**: The exact moment a Company clicks "Approve" on a driver (`ticket_created`).
- **Refund Eligibility**: Null by default. Available only via strictly controlled **Credit Note** process (no auto-refunds).

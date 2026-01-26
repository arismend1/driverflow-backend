# REFUND AND CREDIT POLICY

**Last Updated**: January 20, 2026

## 1. GENERAL POLICY
**ALL SALES ARE FINAL.**
DriverFlow operates as a "Pay-to-Unlock" connection service. Once a connection is unlocked (State: `ACCESS_GRANTED`), the service is fully rendered. We do not provide cash refunds.

## 2. CREDIT NOTES
Instead of cash refunds, we may, at our sole discretion, issue a **Credit Note**. A Credit Note adds balance to your account to be used for future Matches.

### 2.1 Eligibility for Credit Note
You may be eligible for a Credit Note ONLY in the following "System Error" scenarios:
- **Duplicate Charge**: You were charged twice for the exact same Ticket ID.
- **Platform Failure**: Technical logs confirm that after payment, the System failed to transition the state to `contact_reveal: true`.

### 2.2 Ineligibility
You are NOT eligible for credits in "Outcome-Based" scenarios:
- Driver interaction was unsatisfactory.
- Driver did not reply.
- You changed your mind after creating the Ticket.

## 3. DISPUTE PROCESS
1.  **Ticket Review**: Usage of the "Dispute" function flags the Ticket as `DISPUTED`.
2.  **Investigation**: Admin audits system logs for the specific `ticket_id`.
3.  **Resolution**: 
    - If valid error: Admin issues **Credit Note**; Ticket marked `CREDIT_NOTE_ISSUED`.
    - If invalid: Dispute rejected; Ticket remains `PAID`.

## 4. CHARGEBACKS
Initiating a chargeback with your bank for a validly rendered service will result in:
1.  Immediate transition of Company Status to **BLOCKED**.
2.  Permanent ban from the DriverFlow marketplace.
3.  Reporting of the debt to collections.

# OFFICIAL DriverFlow Email & Billing Specification

**Role**: Functional Specification for Future Implementation
**Status**: DRAFT (Pending System Refactor)
**Last Updated**: 2026-01-16

---

## SECTION 1: EMAIL MAP (DEFINITION ONLY)

### A) Operational

1.  **Company Registration Confirmation**
    *   **Trigger**: Successful signup by Company.
    *   **Recipient**: Company Admin.
    *   **Purpose**: Validate email, welcome to platform.
    *   **Nature**: Informational.

2.  **Driver Registration Confirmation**
    *   **Trigger**: Successful signup by Driver.
    *   **Recipient**: Driver.
    *   **Purpose**: Welcome to platform, confirmation of account creation.
    *   **Nature**: Informational.

3.  **Match Confirmed (Ticket Generated)**
    *   **Trigger**: Mutually accepted request (Company & Driver both accepted).
    *   **Recipient**: Company Admin & Driver.
    *   **Purpose**: Notification of successful match and release of contact details. **Marks the creation of a billable ticket.**
    *   **Nature**: Informational / Operational.

### B) Financial

4.  **Weekly Activity Summary**
    *   **Trigger**: Monday 00:00 (Start of new billing cycle).
    *   **Recipient**: Company Admin.
    *   **Purpose**: Summary of tickets generated in the previous week (Mon-Sun).
    *   **Nature**: Financial.

5.  **Weekly Invoice Issued**
    *   **Trigger**: Monday (Processing time).
    *   **Recipient**: Company Admin (Billing Contact).
    *   **Purpose**: Official invoice for the previous week's usage.
    *   **Nature**: Financial (Legally Binding).

6.  **Payment Received Confirmation**
    *   **Trigger**: Successful receipt of payment (Full balance).
    *   **Recipient**: Company Admin.
    *   **Purpose**: Confirmation that the account is up to date for that cycle.
    *   **Nature**: Financial.

### C) Risk / Delinquency

7.  **Late Payment Notice #1**
    *   **Trigger**: 1 unpaid billing cycle (Friday pass without payment).
    *   **Recipient**: Company Admin.
    *   **Purpose**: Friendly reminder of overdue balance.
    *   **Nature**: Warning (Low).

8.  **Late Payment Notice #2**
    *   **Trigger**: 2 unpaid billing cycles.
    *   **Recipient**: Company Admin.
    *   **Purpose**: Urgent reminder of overdue balance.
    *   **Nature**: Warning (Medium).

9.  **Late Payment Notice #3**
    *   **Trigger**: 3 unpaid billing cycles.
    *   **Recipient**: Company Admin.
    *   **Purpose**: Final warning before service blockage.
    *   **Nature**: Warning (Critical).

10. **Account Blocked Notice**
    *   **Trigger**: 4 unpaid billing cycles.
    *   **Recipient**: Company Admin.
    *   **Purpose**: Notification that the account has been suspended due to non-payment.
    *   **Nature**: Warning (Blockage / Service Suspension).

---

## SECTION 2: BILLING CYCLE RULES

*   **Accounting Week**: Monday 00:00:00 to Monday 23:59:59 (Next Monday technically starts next cycle, so effectively Mon 00:00 to Sun 23:59:59). *Correction/Clarification: "Monday 00:00 to Monday 23:59" in prompt implies 8 days? Standard is Mon-Sun. Assuming standard business week Mon-Sun based on "Weekly activity summary (Monday)".* **Official Rule**: Week = Monday 00:00 to the following Sunday 23:59:59. Invoice issued on the *next* Monday.
*   **Debt Generation**: Occurs **immediately** and automatically upon the event of a "Match" (Ticket Generation).
*   **Aggregation**: All tickets generated within the Accounting Week are grouped by Company.
*   **Invoice Issuance**: Generated and sent every **Monday** for the preceding week.
*   **Target Payment Day**: **Friday** of the week the invoice is issued.
*   **Grace Period**: The system allows continued operation for up to 4 consecutive unpaid weekly cycles.
*   **Action at 4th Unpaid Cycle**: **Automatic Account Block**. The company cannot create new requests until the debt is resolved.
*   **Reactivation**: Account is reactivated **only** after full payment of all overdue invoices.

---

## SECTION 3: INVOICE — REQUIRED DATA FIELDS

The generated invoice must contain the following data fields:

*   **Brand Name**: DriverFlow
*   **Legal Entity**: Florida Luxury Services LLC
*   **Client Details**:
    *   Company Name
    *   Company ID (Internal)
*   **Billed Period**: Start Date - End Date (e.g., Jan 12, 2026 - Jan 18, 2026)
*   **Usage Details**:
    *   Number of Tickets (Matches)
*   **Financials**:
    *   Unit Price: **USD 150.00**
    *   Total Amount Due: (Number of Tickets * 150)
*   **Status**: Pending / Paid / Overdue
*   **Dates**:
    *   Issue Date
    *   Payment Due Date (Friday)

---

## SECTION 4: EXPLICIT RULES

*   **No Employment Guarantee**: DriverFlow does NOT guarantee employment, job performance, or service quality by the driver.
*   **Traffic Only**: DriverFlow ONLY sells traffic / contact introduction / intermedia.
*   **Ticket Trigger**: A ticket is generated **ONLY** when contact information is mutually shared (Match).
*   **Non-Refundable**: Tickets are non-refundable once generated, regardless of the outcome of the job.
*   **Email Nature**: Emails are strictly informational; the existence of the debt is independent of whether the email was received or read.
*   **Governing Language**: The official governing language for all operations and conflicts is **English**.

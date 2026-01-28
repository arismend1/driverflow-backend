# 🔒 CODE FREEZE POLICY

**EFFECTIVE DATE:** Immediate
**SCOPE:** Billing & Time Core Modules

## 🚫 RESTRICTED FILES
The following files are **FROZEN**. No functional changes are permitted without Principal Engineer approval:

- `time_contract.js`
- `access_control.js`
- `generate_weekly_invoices.js`
- `worker_queue.js`

## 📝 RULES
1.  **No Refactoring:** stylistic changes are rejected.
2.  **No Features:** new billing logic must go in new modules, not these.
3.  **Exceptions:**
    -   Critical Security Vulnerabilities (CVSS > 7).
    -   Documentation updates.
    -   Fixes for proven production outages.

## 🔓 UNLOCK PROCESS
To modify these files:
1.  Open an Issue titled `[CORE-CHANGE] <Reason>`.
2.  Obtain sign-off from `@driverflow/principal-eng`.
3.  Execute a full 52-week simulation (`simulate_billing_1year.js`) and attach logs.

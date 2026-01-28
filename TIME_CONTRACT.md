# 🕰️ Time Contract (TIME_CONTRACT.md)

**Status:** ENFORCED
**Applies to:** All Billing, Simulation, and Enforcement Logic.

## 1. The Golden Rule
> 🛑 **FORBIDDEN:** Direct use of `Date.now()` or `new Date()` (without arguments) in strict business logic.
> ✅ **REQUIRED:** Use `require('./time_contract')` for ALL current time operations.

## 2. Why does this exist?
We encountered two critical bugs that corrupted our billing simulations:

### A. The "1970 Epoch Ghost"
- **Symptom:** Invoices showing 20,000+ days overdue (~55 years).
- **Cause:** `Date(null)` or `Date(0)` defaults to 1970-01-01. When compared to 2026, this creates massive false debt.
- **Fix:** `time_contract.parseLoose(val)` strictly returns `null` for any date before Year 2000. It is "Anti-Ghost".

### B. The "Time Warp"
- **Symptom:** Simulation drifting to Year 2084.
- **Cause:** Double-multiplication of simulation speed (SIM_TIME_SCALE applied twice).
- **Fix:** `time_contract.nowMs()` manages the offset centrally and enforces a 1:1 scale for stability.

## 3. How to use it?

### Get Current Time
```javascript
const time = require('./time_contract');

// ❌ BAD
const now = Date.now();
const today = new Date();

// ✅ GOOD
const nowMs = time.nowMs({ ctx: 'billing_logic' });
const todayIso = time.nowIso({ ctx: 'invoice_created' });
```

### Parse a Date
```javascript
// ❌ BAD
const d = new Date(input); // Dangerous! might be 1970

// ✅ GOOD
const d = time.parseLoose(input, { minYear: 2000 });
// Returns NULL if input is garbage, 0, or pre-2000.
// Returns valid Date object otherwise.
```

## 4. Safety Mechanisms
If `SIM_TIME=1` is enabled, the contract installs a **Kill-Switch**:
- `Date.now()` will log a CRITICAL WARNING to stderr.
- `new Date()` (empty) is also monitored.

*Do not disable this protection.*

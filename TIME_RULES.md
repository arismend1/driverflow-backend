# 🕰️ TIME RULES (TECHNICAL STANDARD)

> **⚠️ CRITICAL:** This project enforces a STRICT TIME CONTRACT.
> Violations will cause CI failures and Production Incidents.

## 🚫 PROHIBITED
- `Date.now()`
- `new Date()` (constructor without arguments)
- `new Date(string)` (without strict validation)

**Risks:**
- **1970 Ghost:** Dates defaulting to epoch start (`null` -> 1970).
- **Time Warp:** Simulation desync leading to 2084 dates.

## ✅ MANDATORY
Use `time_contract.js` for ALL time operations.

### 1. Get Current Time
```javascript
const time = require('./time_contract');
const now = time.nowMs({ ctx: 'my_context' }); // Number (ms)
const iso = time.nowIso({ ctx: 'my_context' }); // String (ISO)
```

### 2. Parse User/DB Input
```javascript
// Returns valid Date or NULL (if invalid/pre-2000)
const date = time.parseLoose(inputPayload.date, { minYear: 2000 });
if (!date) throw new Error("Invalid/Old Date");
```

## 💥 VIOLATIONS
If you use `Date.now()` directly:
1.  **Locally/Production:** It behaves normally (unless monkey-patched).
2.  **Simulation/Test:** The **Kill-Switch** activates, logging errors and failing builds.

See [TIME_CONTRACT.md](./TIME_CONTRACT.md) for architecture.

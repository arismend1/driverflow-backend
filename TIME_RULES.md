# 🕰️ TIME RULES & ONBOARDING

> **⚠️ CRITICAL:** This project operates under a Strict Time Contract.
> Violating these rules will cause immediate CI failure and potential production data corruption.

## 🚫 PROHIBITED
- `Date.now()`
- `new Date()` (constructor without arguments)
- `new Date(string)` (without strict parsing validation)

**Why?**
These native functions are vulnerable to:
1. **The 1970 Epoch Ghost:** Defaulting `null`/`0` to 1970-01-01, causing 50+ years of false debt.
2. **Time Warps:** Desynchronization during simulation (`SIM_TIME=1`), leading to dates in 2084.

## ✅ MANDATORY
You MUST use the specialized `time_contract` module for ALL time operations.

### 1. Timestamps (Numeric)
```javascript
const time = require('./time_contract');
const now = time.nowMs({ ctx: 'my_function_reason' }); // Returns milliseconds
```

### 2. Dates (ISO String)
```javascript
const nowIso = time.nowIso({ ctx: 'db_insert_created_at' }); // Returns "2026-05-12T..."
```

### 3. Parsing (User/DB Input)
```javascript
// Automatically rejects < 2000 dates (returns null)
const validDate = time.parseLoose(inputPayload.date, { minYear: 2000 });
if (!validDate) throw new Error("Invalid Date");
```

## 📚 Reference
See [TIME_CONTRACT.md](./TIME_CONTRACT.md) for full architectural details.

# 🚀 PRODUCTION DEPLOY CHECKLIST

**Target:** `driverflow-mvp` (Billing & Simulation Core)
**Criticality:** HIGH (Financial Impact)

## 1. PRE-DEPLOY (Staging/Canary)
- [ ] **Code Freeze:** Confirm no modifications to `time_contract.js` or `access_control.js` in the release commit.
- [ ] **CI Verification:** Check GitHub Actions `Validate Time Logic` passed (Green).
- [ ] **Staging Smoke Test:**
    ```bash
    # MUST return 0 exit code and NO "WARNING: Date.now() called"
    node tests/test_time_regression.js
    ```
- [ ] **Environment Check:** ensure `SIM_TIME` is NOT set to `1` in production ENV variables (unless specifically intended for parallel sim).

## 2. PRODUCTION DEPLOY
- [ ] **DB Snapshot:** Backup `driverflow.db` to s3/glacier `driverflow_pre_deploy_YYYYMMDD.db`.
- [ ] **Deploy Code:** Pull `main` / Restart Service.
- [ ] **Health Check:** `GET /readyz` should return HTTP 200.
- [ ] **Log Monitoring:** Tail logs for 5 mins looking for `[TimeContract] ⚠️ WARNING` or `[TimeContract] 🛑 ERROR`.

## 3. ROLLBACK CRITERIA
Initiate immediate rollback if:
- Any `Date.now()` warning appears in logs.
- `GET /readyz` fails for > 1 min.
- Invoice generation count = 0 on expected billing day.

## 4. POST-DEPLOY
- [ ] Verify `access_control` logic on 1 sample user.
- [ ] Confirm no "Ghost Debt" (invoice dates < 2025).

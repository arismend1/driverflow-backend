# 🚀 DEPLOY CHECKLIST (OPERATIONAL)

**Target:** `driverflow-mvp` (Production)

## 1. STAGING (Canary)
- [ ] **Deploy Code:** Push to staging environment.
- [ ] **Run Regression:** `node tests/test_time_regression.js` (MUST PASS).
- [ ] **Log Audit:** Check logs for `"[TimeContract] ⚠️"` warnings.
- [ ] **Config Check:** Ensure `DB_PATH` is correct.

## 2. PRODUCTION PREP
- [ ] **Code Freeze:** Confirm `CODE_FREEZE.md` hasn't been violated.
- [ ] **Backup:** `cp driverflow.db driverflow_backup_YYYYMMDD.db`.

## 3. ROLLOUT
- [ ] **Deploy:** `git pull && npm install --production`.
- [ ] **Restart:** `pm2 restart server` (or equivalent).
- [ ] **Health Check:** `curl localhost:port/readyz` -> `{"ok":true}`.
- [ ] **Smoke Test:** Login with test account.

## 4. ROLLBACK PLAN
If logs show Date/Time errors or Billing fails:
1.  Restore usage of `driverflow_backup.db`.
2.  Revert code to previous commit.
3.  Restart service.

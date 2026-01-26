// ⚠️ FROZEN LOGIC — MODIFIED BY USER REQUEST (28-day rule)
const { enforceCompanyCanOperate } = require('./access_control');

/**
 * Strict delinquency enforcement wrapper.
 * Delegates to access_control.js which implements the "28 days since last payment" rule.
 * 
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} companyId
 * @returns {{ blocked: boolean, overdueCount: number }}
 */
function checkAndEnforceBlocking(db, companyId) {
  try {
    enforceCompanyCanOperate(db, Number(companyId), 'check_delinquency_job');
    // If no error, not blocked.
    // Calculate overdue count just for reporting return value (backward compatibility)
    const pendingCount = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE company_id = ? AND status='pending'").get(companyId).c;
    return { blocked: false, overdueCount: pendingCount };
  } catch (e) {
    if (e.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') {
      const pendingCount = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE company_id = ? AND status='pending'").get(companyId).c;
      return { blocked: true, overdueCount: pendingCount };
    }
    throw e;
  }
}

module.exports = { checkAndEnforceBlocking };

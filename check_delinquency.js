// ⚠️ FROZEN LOGIC — DO NOT MODIFY
const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { checkAndEnforceBlocking } = require('./delinquency');

const companyId = process.argv[2];
if (!companyId) {
  console.error('Usage: node check_delinquency.js <company_id>');
  process.exit(1);
}

try {
  const res = checkAndEnforceBlocking(db, companyId);
  const state = db.prepare(`
    SELECT is_blocked, blocked_reason, blocked_at
    FROM empresas
    WHERE id = ?
  `).get(Number(companyId));

  console.log(JSON.stringify({
    companyId: Number(companyId),
    overdueCount: res.overdueCount,
    blocked: res.blocked,
    db_state: state || null
  }, null, 2));
} catch (e) {
  console.error('Check failed:', e);
  process.exit(1);
}

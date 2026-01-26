const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { checkAndEnforceBlocking } = require('./delinquency');

const companyId = parseInt(process.argv[2]);

if (!companyId) {
    console.log("Usage: node simulate_create_request_guard.js <company_id>");
    process.exit(1);
}

// Check DB state directly
const comp = db.prepare("SELECT is_blocked, blocked_reason FROM empresas WHERE id = ?").get(companyId);

if (comp && comp.is_blocked === 1) {
    console.log("403 ACCOUNT_BLOCKED_OVERDUE_INVOICES");
    console.log(`Reason: ${comp.blocked_reason}`);
    process.exit(0); // Exit success but prints 403
} else {
    console.log("200 OK");
}

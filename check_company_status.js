const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH, { readonly: true });
const companyId = Number(process.argv[2]);
const row = db.prepare('SELECT is_blocked, blocked_reason FROM empresas WHERE id=?').get(companyId);
console.log({ companyId, is_blocked: row ? row.is_blocked : null, blocked_reason: row ? row.blocked_reason : null });

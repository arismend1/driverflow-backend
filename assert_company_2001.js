const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH, { readonly: true });

const pending = db.prepare(`
  SELECT COUNT(*) AS c
  FROM invoices
  WHERE company_id = 2001 AND status='pending'
`).get().c;

const company = db.prepare(`
  SELECT is_blocked, blocked_reason
  FROM empresas
  WHERE id = 2001
`).get();

const result = {
  pending_invoices_2001: pending,
  is_blocked: company ? company.is_blocked : null,
  blocked_reason: company ? company.blocked_reason : null
};

console.log(result);

if (pending > 4) {
  console.error("ASSERT FAIL: pending_invoices_2001 > 4");
  process.exit(2);
}
if (!company || company.is_blocked !== 1) {
  console.error("ASSERT FAIL: company 2001 not blocked");
  process.exit(3);
}
process.exit(0);

const Database = require("better-sqlite3");

const companyId = Number(process.argv[2]);
if (!companyId) {
  console.error("Usage: node audit_company_ledger.js <companyId>");
  process.exit(1);
}

const db = new Database(process.env.DB_PATH, { readonly: true });

const invoices = db.prepare(`
  SELECT
    billing_week,
    id,
    status,
    issue_date,
    due_date,
    paid_at,
    total_cents
  FROM invoices
  WHERE company_id = ?
  ORDER BY billing_week
`).all(companyId);

const company = db.prepare(`
  SELECT id, is_blocked, blocked_reason, blocked_at
  FROM empresas
  WHERE id = ?
`).get(companyId);

console.log(JSON.stringify({ company, invoices }, null, 2));

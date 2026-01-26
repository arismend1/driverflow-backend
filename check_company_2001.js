const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH, { readonly: true });

const companyId = 2001;

const pending = db.prepare(`
  SELECT COUNT(*) AS pending_invoices
  FROM invoices
  WHERE company_id = ?
    AND status = 'pending'
`).get(companyId);

const blocked = db.prepare(`
  SELECT is_blocked, blocked_reason
  FROM empresas
  WHERE id = ?
`).get(companyId);

console.log({
  companyId,
  pending_invoices: pending.pending_invoices,
  is_blocked: blocked?.is_blocked ?? null,
  blocked_reason: blocked?.blocked_reason ?? null
});

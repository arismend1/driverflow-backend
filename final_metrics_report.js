const Database = require("better-sqlite3");
const { nowIso } = require("./time_provider");
const { checkAndEnforceBlocking } = require("./delinquency");

const db = new Database(process.env.DB_PATH, { readonly: true });

function q(sql, params=[]) {
  return db.prepare(sql).all(params);
}
function one(sql, params=[]) {
  return db.prepare(sql).get(params);
}

const now = nowIso();
const today = now.split("T")[0]; // YYYY-MM-DD (sim time)

const companies = [2001,2002,2003];

// GLOBAL
const global = {
  tickets_unbilled: one(`SELECT COUNT(*) c FROM tickets WHERE billing_status='unbilled'`).c,
  tickets_billed: one(`SELECT COUNT(*) c FROM tickets WHERE billing_status='billed'`).c,
  invoices_total: one(`SELECT COUNT(*) c FROM invoices`).c,
  invoices_pending: one(`SELECT COUNT(*) c FROM invoices WHERE status='pending'`).c,
  invoices_paid: one(`SELECT COUNT(*) c FROM invoices WHERE status='paid'`).c,
  outbox_by_status: q(`
    SELECT process_status, COUNT(*) AS count
    FROM events_outbox
    GROUP BY process_status
    ORDER BY process_status
  `),
  outbox_pending_invoice_generated: q(`
    SELECT COUNT(*) AS count
    FROM events_outbox
    WHERE event_name='invoice_generated' AND process_status='pending'
  `)[0]?.count ?? 0,
};

function companyReport(companyId) {
  // Delinquency enforcement logic (read-only DB here; but function may UPDATE.
  // So we call it against a read-write handle in a second connection ONLY for status accuracy.
  const db2 = new Database(process.env.DB_PATH); // RW
  const d = checkAndEnforceBlocking(db2, companyId);
  db2.close();

  const pending = one(`SELECT COUNT(*) c FROM invoices WHERE company_id=? AND status='pending'`, [companyId]).c;
  const paid = one(`SELECT COUNT(*) c FROM invoices WHERE company_id=? AND status='paid'`, [companyId]).c;
  const total = one(`SELECT COUNT(*) c FROM invoices WHERE company_id=?`, [companyId]).c;

  const overdue = one(`
    SELECT COUNT(*) c
    FROM invoices
    WHERE company_id=?
      AND status='pending'
      AND due_date IS NOT NULL
      AND due_date < ?
  `, [companyId, today]).c;

  const empresa = one(`SELECT is_blocked, blocked_reason, blocked_at FROM empresas WHERE id=?`, [companyId]);

  const tickets_unbilled = one(`SELECT COUNT(*) c FROM tickets WHERE company_id=? AND billing_status='unbilled'`, [companyId]).c;
  const tickets_billed = one(`SELECT COUNT(*) c FROM tickets WHERE company_id=? AND billing_status='billed'`, [companyId]).c;

  return {
    companyId,
    invoices: { total, pending, paid, overdue },
    company_state: empresa ?? null,
    delinquency_check: d,
    tickets: { unbilled: tickets_unbilled, billed: tickets_billed },
  };
}

const perCompany = companies.map(companyReport);

console.log(JSON.stringify({
  db_path: process.env.DB_PATH,
  sim_now: now,
  today,
  global,
  perCompany
}, null, 2));

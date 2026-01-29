const Database = require('better-sqlite3');
const db = new Database('driverflow_sim_1yr.db');

const metrics = {
    companies_worked: db.prepare("SELECT count(DISTINCT company_id) as c FROM tickets").get().c,
    matches_made: db.prepare("SELECT count(*) as c FROM tickets").get().c,
    invoices_paid: db.prepare("SELECT count(*) as c FROM invoices WHERE status='paid'").get().c,
    invoices_pending: db.prepare("SELECT count(*) as c FROM invoices WHERE status!='paid' AND status!='void'").get().c,
    companies_blocked: db.prepare("SELECT count(*) as c FROM empresas WHERE is_blocked=1").get().c
};

console.log("--- 1 YEAR SIMULATION KPI REPORT ---");
console.log(`[KPI] Companies Worked (Distinct): ${metrics.companies_worked}`);
console.log(`[KPI] Total Matches Made: ${metrics.matches_made}`);
console.log(`[KPI] Invoices Paid: ${metrics.invoices_paid}`);
console.log(`[KPI] Invoices Pending/Overdue: ${metrics.invoices_pending}`);
console.log(`[KPI] Companies Blocked: ${metrics.companies_blocked}`);

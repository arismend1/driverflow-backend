const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { nowIso } = require('./time_provider');

const companyId = process.argv[2];
if (!companyId) {
    console.log("Usage: node show_billing_state.js <company_id>");
    process.exit(1);
}

console.log(`--- Billing State: Company ${companyId} ---`);
console.log(`Sim Now: ${nowIso()}`);

// Company Block Status
const comp = db.prepare("SELECT is_blocked, blocked_reason FROM empresas WHERE id = ?").get(companyId);
if (comp) {
    console.log(`Blocked: ${comp.is_blocked} (${comp.blocked_reason || 'None'})`);
} else {
    console.log("Company not found!");
}

// Tickets
console.log("\n[Tickets]");
const tickets = db.prepare("SELECT id, request_id, created_at, billing_status, billing_week FROM tickets WHERE company_id = ? ORDER BY created_at").all(companyId);
if (tickets.length === 0) console.log("  None");
tickets.forEach(t => {
    console.log(`  ID: ${t.id} | Req: ${t.request_id} | Week: ${t.billing_week || 'N/A'} | Status: ${t.billing_status} | Created: ${t.created_at}`);
});

// Invoices
console.log("\n[Invoices]");
const invoices = db.prepare("SELECT id, billing_week, issue_date, due_date, status, total_cents, paid_at FROM invoices WHERE company_id = ? ORDER BY billing_week").all(companyId);
if (invoices.length === 0) console.log("  None");
invoices.forEach(inv => {
    // Count items
    const items = db.prepare("SELECT count(*) as c FROM invoice_items WHERE invoice_id = ?").get(inv.id).c;
    console.log(`  ID: ${inv.id} | Week: ${inv.billing_week} | Due: ${inv.due_date} | Status: ${inv.status} | Paid: ${inv.paid_at || '-'} | Total: ${inv.total_cents} | Items: ${items}`);
});

console.log("-------------------------------------------");

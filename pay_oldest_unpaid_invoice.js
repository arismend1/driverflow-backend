const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { nowIso } = require('./time_provider');
const { checkAndEnforceBlocking } = require('./delinquency');

const companyId = parseInt(process.argv[2]);

if (!companyId) {
    console.log("Usage: node pay_oldest_unpaid_invoice.js <company_id>");
    process.exit(1);
}

// 1. Find the oldest invoice that is PENDING (unpaid) or PARTIAL?
// Schema says check if `paid_at` is null or status?
// Invoices table has 'status'. 'pending', 'paid', 'overdue'?
// delinquency.js checks if due_date < now AND (status='pending' OR status='overdue'??)
// Actually generate_weekly_invoices sets status='pending'.
// Let's check pending or overdue. Ideally anything not 'paid' or 'void'.
const invoice = db.prepare(`
    SELECT id, status, due_date, total_cents 
    FROM invoices 
    WHERE company_id = ? 
      AND (status = 'pending' OR status = 'overdue')
    ORDER BY due_date ASC, id ASC
    LIMIT 1
`).get(companyId);

if (!invoice) {
    console.log("No pending/overdue invoices found to pay.");
    process.exit(0);
}

console.log(`Found Oldest Unpaid Invoice: ID ${invoice.id} (Status: ${invoice.status}, Due: ${invoice.due_date})`);

// 2. Mark Paid
// Transaction
const runTx = db.transaction(() => {
    const paidTime = nowIso();

    // Update Invoice
    db.prepare(`
        UPDATE invoices 
        SET status = 'paid', 
            paid_at = ?, 
            paid_method = 'manual_sim' 
        WHERE id = ?
    `).run(paidTime, invoice.id);

    // Emit Event
    db.prepare(`
        INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata)
        VALUES ('invoice_paid', ?, ?, ?, ?)
    `).run(paidTime, companyId, invoice.id, JSON.stringify({
        invoice_id: invoice.id,
        amount_cents: invoice.total_cents,
        method: 'manual_sim'
    }));
});

runTx();
console.log(`PAID_INVOICE_ID=${invoice.id}`);
console.log(`✅ Invoice ${invoice.id} marked as PAID.`);

// 3. Re-calculate Blocking
checkAndEnforceBlocking(db, companyId);
console.log("Blocking status re-evaluated.");

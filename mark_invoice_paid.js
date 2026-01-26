const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { checkAndEnforceBlocking } = require('./delinquency');

const { nowIso } = require('./time_provider');

const invoiceId = process.argv[2];

if (!invoiceId) {
    console.error("Usage: node mark_invoice_paid.js <invoice_id>");
    process.exit(1);
}

console.log(`--- Marking Invoice ${invoiceId} as PAID ---`);

const performMarkPaid = db.transaction(() => {
    // 1. Check Invoice Exists and Status
    const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status === 'paid') {
        console.log("Invoice already paid.");
        return;
    }

    // 2. Update Status
    db.prepare(`
        UPDATE invoices 
        SET status = 'paid', paid_at = ?, paid_method = 'manual' 
        WHERE id = ?
    `).run(nowIso(), invoiceId);

    // 3. Emit Event (invoice_paid)
    // Idempotency: request_id = invoice_id
    try {
        db.prepare(`
            INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata)
            VALUES (?, ?, ?, ?, ?)
        `).run('invoice_paid', nowIso(), invoice.company_id, invoiceId, JSON.stringify({ invoice_id: invoiceId }));
        console.log("Event invoice_paid emitted.");
    } catch (e) {
        if (!e.message.includes('UNIQUE constraint failed')) throw e;
        console.log("Event already emitted.");
    }

    // 4. Recalculate Block
    const res = checkAndEnforceBlocking(db, invoice.company_id);
    console.log(`Block recalculation for Company ${invoice.company_id}: Overdue=${res.overdueCount}, IsBlocked=${res.blocked}`);
});

try {
    performMarkPaid();
    console.log("✅ Operation successful.");
} catch (e) {
    console.error("❌ Failed:", e.message);
    process.exit(1);
}

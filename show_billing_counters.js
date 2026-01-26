const Database = require('better-sqlite3');
const path = require('path');

// 1. Resolve and Validate DB_PATH
const dbPath = process.env.DB_PATH;
if (!dbPath) {
    console.error('Error: DB_PATH environment variable not set.');
    process.exit(1);
}

try {
    // 2. Connect to Database (fileMustExist ensures clear error if missing)
    const db = new Database(dbPath, { fileMustExist: true, readonly: true });

    // 3. Execute Queries
    const getCount = (query) => db.prepare(query).get().count;

    const ticketsUnbilled = getCount("SELECT COUNT(1) as count FROM tickets WHERE billing_status = 'unbilled'");
    const ticketsBilled = getCount("SELECT COUNT(1) as count FROM tickets WHERE billing_status = 'billed'");
    const invoicesTotal = getCount("SELECT COUNT(1) as count FROM invoices");
    const invoicesPending = getCount("SELECT COUNT(1) as count FROM invoices WHERE status = 'pending'");
    const eventsPending = getCount("SELECT COUNT(1) as count FROM events_outbox WHERE process_status = 'pending' AND event_name = 'invoice_generated'");

    // 4. Output Results
    console.log(`tickets_unbilled: ${ticketsUnbilled}`);
    console.log(`tickets_billed: ${ticketsBilled}`);
    console.log(`invoices_total: ${invoicesTotal}`);
    console.log(`invoices_pending: ${invoicesPending}`);
    console.log(`invoice_generated_events_pending: ${eventsPending}`);

    // Close connection
    db.close();

} catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
}

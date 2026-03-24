const db = require('./db_adapter');
const logger = require('./logger');

async function audit() {
    try {
        console.log("--- TICKETS (Last 20) ---");
        const tickets = await db.all("SELECT * FROM tickets ORDER BY created_at DESC LIMIT 20");
        console.table(tickets);

        console.log("\n--- INVOICES (Last 20) ---");
        const invoices = await db.all("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 20");
        console.table(invoices);

        console.log("\n--- WEEKLY_INVOICES (Last 20) ---");
        // Note: The code in worker_queue.js uses 'invoices' table, 
        // but user mentioned 'weekly_invoices'. I'll check both if they exist.
        try {
            const weekly_invoices = await db.all("SELECT * FROM weekly_invoices ORDER BY created_at DESC LIMIT 20");
            console.table(weekly_invoices);
        } catch (e) {
            console.log("weekly_invoices table NOT found or error:", e.message);
        }

        console.log("\n--- BILLABLE TICKETS CHECK ---");
        const billable = await db.all("SELECT count(*) as cnt FROM tickets WHERE billing_status = 'billable'");
        console.log("Billable tickets count:", billable[0].cnt);

        console.log("\n--- TICKETS 16 & 18 RELATIONSHIP ---");
        const t16_18 = await db.all("SELECT id, billing_status, created_at FROM tickets WHERE id IN (16, 18)");
        console.table(t16_18);

        const relation = await db.all(`
            SELECT ii.invoice_id, ii.ticket_id, i.status, i.created_at as invoice_created
            FROM invoice_items ii
            JOIN invoices i ON ii.invoice_id = i.id
            WHERE ii.ticket_id IN (16, 18)
        `);
        console.table(relation);

        console.log("\n--- WORKER HEARTBEAT ---");
        const heartbeats = await db.all("SELECT * FROM worker_heartbeat");
        console.table(heartbeats);

    } catch (e) {
        console.error("Audit Error:", e);
    } finally {
        db.close();
    }
}

audit();

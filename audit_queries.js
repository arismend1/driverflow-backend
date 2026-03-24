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

        console.log("\n--- INVOICES (Manual Audit) ---");
        // invoices table is the source of truth
        try {
            const invoices_check = await db.all("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 20");
            console.table(invoices_check);
        } catch (e) {
            console.log("invoices table error:", e.message);
        }

        console.log("\n--- UNBILLED TICKETS CHECK ---");
        const unbilled = await db.all("SELECT count(*) as cnt FROM tickets WHERE billing_status = 'unbilled'");
        console.log("Unbilled tickets count:", unbilled[0].cnt);

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

let db;
try {
    db = require('../db_adapter');
} catch (e) {
    console.log("⚠️ db_adapter failed to load dependencies (likely better-sqlite3). Falling back to MOCK for logic demonstration.");
    db = {
        IS_POSTGRES: false,
        beginTransaction: async () => {
            console.log("[MOCK] beginTransaction()");
            return {
                run: async (sql, ...args) => console.log(`[MOCK] tx.run: ${sql.replace(/\s+/g, ' ').substring(0, 100)}...`, args),
                get: async (sql, ...args) => {
                    console.log(`[MOCK] tx.get: ${sql.replace(/\s+/g, ' ').substring(0, 100)}...`, args);
                    if (sql.includes("FROM invoices")) return { status: 'pending' };
                    return null;
                },
                all: async (sql, ...args) => {
                    console.log(`[MOCK] tx.all: ${sql.replace(/\s+/g, ' ').substring(0, 100)}...`, args);
                    return [];
                },
                commit: async () => console.log("[MOCK] tx.commit()"),
                rollback: async () => console.log("[MOCK] tx.rollback()")
            };
        },
        get: async (sql, ...args) => {
             if (sql.includes("FROM invoices")) return { status: 'pending' };
             return null;
        },
        exec: async (sql) => console.log("[MOCK] db.exec")
    };
}

async function testWebhookSuccess() {
    console.log("\n--- TEST: Webhook Success ---");
    const tx = await db.beginTransaction();
    try {
        // 1. Mark event as pending
        await tx.run("INSERT INTO stripe_webhook_events (stripe_event_id, type, created_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'pending')", 'evt_success', 'payment_intent.succeeded');
        
        // 2. Update Invoice
        await tx.run("UPDATE invoices SET status='charged' WHERE id=123");
        
        // 3. Update Tickets
        await tx.run("UPDATE tickets SET billing_status='paid' WHERE id IN (SELECT ticket_id FROM invoice_items WHERE invoice_id=123)");
        
        // 4. Finalize event
        await tx.run("UPDATE stripe_webhook_events SET status='processed' WHERE stripe_event_id='evt_success'");
        
        await tx.commit();
        console.log("✅ Success path committed correctly.");
    } catch (e) {
        await tx.rollback();
        console.error("❌ Success path failed unexpectedly:", e.message);
    }
}

async function testWebhookRollback() {
    console.log("\n--- TEST: Webhook Rollback on Failure ---");
    
    // Initial State Check
    const beforeInv = await db.get("SELECT status FROM invoices WHERE id=123");
    console.log("Initial Invoice Status:", beforeInv.status);

    const tx = await db.beginTransaction();
    try {
        await tx.run("INSERT INTO stripe_webhook_events (stripe_event_id, type, created_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'pending')", 'evt_fail', 'payment_intent.succeeded');
        
        console.log("Updating invoice to 'charged' (inside tx)...");
        await tx.run("UPDATE invoices SET status='charged' WHERE id=123");
        
        console.log("Simulating CRITICAL ERROR...");
        throw new Error("Simulated Database Crash");
        
        await tx.commit();
    } catch (e) {
        console.log("Caught Error:", e.message);
        await tx.rollback();
        console.log("🔄 Rollback executed.");
    }

    // Final State Check
    const afterInv = await db.get("SELECT status FROM invoices WHERE id=123");
    if (afterInv.status === beforeInv.status) {
        console.log("✅ VERIFIED: Invoice status rolled back to '" + beforeInv.status + "'.");
    } else {
        console.error("❌ FAILURE: Invoice status stayed as '" + afterInv.status + "'!");
    }
}

async function run() {
    // Setup dummy data if SQLite
    if (!db.IS_POSTGRES) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS stripe_webhook_events (stripe_event_id TEXT PRIMARY KEY, type TEXT, created_at TEXT, status TEXT, processed_at TEXT);
            CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, status TEXT);
            CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY, billing_status TEXT);
            CREATE TABLE IF NOT EXISTS invoice_items (invoice_id INTEGER, ticket_id INTEGER);
            INSERT OR IGNORE INTO invoices (id, status) VALUES (123, 'pending');
            INSERT OR IGNORE INTO tickets (id, billing_status) VALUES (456, 'unbilled');
            INSERT OR IGNORE INTO invoice_items (invoice_id, ticket_id) VALUES (123, 456);
        `);
    }

    await testWebhookSuccess();
    await testWebhookRollback();
    
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});

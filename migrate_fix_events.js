const db = require('./db_adapter');

(async () => {
    console.log('--- [MIGRATION] FIX EVENTS OUTBOX SCHEMA ---');

    // 1. Ensure queue_status column exists (Postgres)
    try {
        await db.run("ALTER TABLE events_outbox ADD COLUMN queue_status TEXT DEFAULT 'pending'");
        console.log("✅ Added queue_status column");
    } catch (e) {
        // Ignore "already exists"
    }

    // 2. Fix NULL queue_status
    try {
        const res = await db.run("UPDATE events_outbox SET queue_status='pending' WHERE queue_status IS NULL");
        console.log(`✅ Fixed ${res.changes || res.rowCount} events with NULL queue_status`);
    } catch (e) {
        console.error("Error fixing queue_status:", e.message);
    }

    // 3. Ensure queue_status has DEFAULT 'pending' (Postgres)
    try {
        await db.run("ALTER TABLE events_outbox ALTER COLUMN queue_status SET DEFAULT 'pending'");
        console.log("✅ Set DEFAULT 'pending' for queue_status");
    } catch (e) {
        // Might fail on SQLite or if generic adapter doesn't support complex ALTER
        console.warn("Could not set DEFAULT (might be SQLite or already set):", e.message);
    }

    // 4. Fix jobs_queue if needed (status shouldn't be null but checking)
    try {
        await db.run("UPDATE jobs_queue SET status='pending' WHERE status IS NULL");
    } catch (e) { }

    console.log('--- [MIGRATION] DONE ---');
})();

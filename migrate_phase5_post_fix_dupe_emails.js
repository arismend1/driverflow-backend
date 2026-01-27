const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'driverflow.db');
const db = new Database(DB_PATH);

console.log('--- Migrating Phase 5 Post-Fix (Dupe Emails) ---');

try {
    // 1. Add columns to events_outbox for Atomic Bridge
    // queue_status: pending | queued | bridged
    try {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN queue_status TEXT DEFAULT 'pending'").run();
        console.log("CHECK: Added 'queue_status' to events_outbox");
    } catch (e) {
        if (!e.message.includes('duplicate column')) console.error("Error adding queue_status:", e.message);
    }

    try {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN queued_at DATETIME").run();
        console.log("CHECK: Added 'queued_at' to events_outbox");
    } catch (e) {
        if (!e.message.includes('duplicate column')) console.error("Error adding queued_at:", e.message);
    }

    // 2. Add source_event_id to jobs_queue for unique constraint tracking
    try {
        db.prepare("ALTER TABLE jobs_queue ADD COLUMN source_event_id INTEGER").run();
        console.log("CHECK: Added 'source_event_id' to jobs_queue");
    } catch (e) {
        if (!e.message.includes('duplicate column')) console.error("Error adding source_event_id:", e.message);
    }

    // 3. Create Unique Index to prevent double-hiring of same event
    try {
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_event ON jobs_queue(source_event_id) WHERE source_event_id IS NOT NULL").run();
        console.log("CHECK: Created UNIQUE INDEX idx_jobs_source_event on jobs_queue");
    } catch (e) {
        console.error("Error creating index:", e.message);
    }

    // 4. Backfill existing jobs? (Optional, maybe not needed for post-fix if we assume fresh or empty)
    // We leave old jobs as is.

    console.log('--- Migration Post-Fix Complete ---');

} catch (e) {
    console.error('Migration Failed:', e);
    process.exit(1);
}

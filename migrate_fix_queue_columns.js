const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const db = new Database(DB_PATH);

console.log(`--- Migrating: Fix Queue Columns on ${DB_PATH} ---`);

try {
    const tableInfo = db.prepare("PRAGMA table_info(events_outbox)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('queue_status')) {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN queue_status TEXT DEFAULT 'pending'").run();
        console.log('✅ Added queue_status to events_outbox');
    }

    if (!columns.includes('queued_at')) {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN queued_at TEXT").run();
        console.log('✅ Added queued_at to events_outbox');
    }

    // Add index for performance
    db.prepare("CREATE INDEX IF NOT EXISTS idx_events_queue ON events_outbox(queue_status)").run();

    console.log('✅ Queue Columns Migration Complete');

} catch (err) {
    console.error('❌ Migration Failed:', err.message);
    process.exit(1);
}

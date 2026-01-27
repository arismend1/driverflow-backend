const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const db = new Database(DB_PATH);

console.log(`--- Migrating: Phase 5.4 Queue on ${DB_PATH} ---`);

try {
    const run = db.transaction(() => {
        // 1. Jobs Queue table
        db.prepare(`
            CREATE TABLE IF NOT EXISTS jobs_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, done, failed, dead
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 5,
                run_at TEXT NOT NULL,
                locked_by TEXT,
                locked_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                idempotency_key TEXT UNIQUE
            )
        `).run();

        // 1.1 Check for Schema Drift (source_event_id)
        // 1.1 Check for Schema Drift (source_event_id)
        const jqInfo = db.prepare("PRAGMA table_info(jobs_queue)").all();
        if (!jqInfo.find(c => c.name === 'source_event_id')) {
            db.prepare("ALTER TABLE jobs_queue ADD COLUMN source_event_id INTEGER").run();
            // Add unique index separately
            db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_event ON jobs_queue(source_event_id)").run();
            console.log('✅ Added source_event_id to jobs_queue');
        }

        // 2. Indices
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_fetch ON jobs_queue(status, run_at)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_lock ON jobs_queue(locked_at)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs_queue(job_type)`).run();

        // 3. Ensure Heartbeat Table (Phase 3 created it, but ensuring idempotency)
        db.prepare(`
            CREATE TABLE IF NOT EXISTS worker_heartbeat (
                worker_name TEXT PRIMARY KEY,
                last_seen TEXT NOT NULL,
                status TEXT,
                metadata TEXT
            )
        `).run();

        // 4. Update events_outbox for Bridge
        const tableInfo = db.prepare("PRAGMA table_info(events_outbox)").all();
        const columns = tableInfo.map(c => c.name);

        if (!columns.includes('queue_status')) {
            db.prepare("ALTER TABLE events_outbox ADD COLUMN queue_status TEXT DEFAULT 'pending'").run();
        }
        if (!columns.includes('queued_at')) {
            db.prepare("ALTER TABLE events_outbox ADD COLUMN queued_at TEXT").run();
        }
        db.prepare("CREATE INDEX IF NOT EXISTS idx_events_queue ON events_outbox(queue_status)").run();

        console.log('✅ jobs_queue table & indices synced.');
    });

    run();
    console.log('✅ Phase 5.4 Queue Migration Complete');

} catch (err) {
    console.error('❌ Migration Failed:', err.message);
    process.exit(1);
}

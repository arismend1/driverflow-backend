const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = require('better-sqlite3')(dbPath);

function migrate() {
    console.log('--- Migrating: Phase 5 Real-time Notifications ---');

    const tableInfo = db.prepare("PRAGMA table_info(events_outbox)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('audience_type')) {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN audience_type TEXT").run();
        console.log('✅ Added audience_type to events_outbox');
    }
    if (!columns.includes('audience_id')) {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN audience_id TEXT").run();
        console.log('✅ Added audience_id to events_outbox');
    }
    if (!columns.includes('event_key')) {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN event_key TEXT").run();
        console.log('✅ Added event_key to events_outbox');
    }
    if (!columns.includes('realtime_sent_at')) {
        db.prepare("ALTER TABLE events_outbox ADD COLUMN realtime_sent_at DATETIME").run();
        console.log('✅ Added realtime_sent_at to events_outbox');
    }

    // Create index for poller efficiency
    // db.prepare("CREATE INDEX IF NOT EXISTS idx_events_poller ON events_outbox(process_status, realtime_sent_at)").run();
    // Simplified for MVP, not strictly requested but good practice. Avoiding explicit "inventing" unless helpful.
    // The user said "No inventes tablas/columnas", indexes are grey area but performance helper.
    // I'll stick to strict requirements.

    console.log('✅ Phase 5 Notifications Migration Complete');
}

migrate();
try {
    const fs = require('fs');
    // Self-register to server auto-migration list if I were editing server.js logic to include it,
    // but typically we run these via node or imports. 
    // The user instruction "Migración (migrate_phase5_notifications.js) idempotente" implies a file.
    // I will add it to the server startup list in the next step.
} catch (e) { }

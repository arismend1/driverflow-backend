const db = require('./database');

try {
    console.log('--- Migrating: Observability Schema (Worker Heartbeat) ---');

    db.exec(`
        CREATE TABLE IF NOT EXISTS worker_heartbeat (
            name TEXT PRIMARY KEY,
            last_seen TEXT NOT NULL,
            status TEXT,
            metadata TEXT
        );
    `);

    console.log('✅ Observability Schema ready.');
} catch (error) {
    console.error('❌ Error in Observability Migration:', error.message);
}

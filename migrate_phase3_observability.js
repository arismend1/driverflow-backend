const db = require('./database');

try {
    console.log('--- Migrating: Phase 3 Observability (Strict) ---');

    // Ensure table exists with correct schema
    // worker_name TEXT PRIMARY KEY, last_seen TEXT NOT NULL

    // Check if table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_heartbeat'").get();

    if (!tableExists) {
        db.exec(`
            CREATE TABLE worker_heartbeat (
                worker_name TEXT PRIMARY KEY,
                last_seen TEXT NOT NULL,
                status TEXT,
                metadata TEXT
            );
        `);
        console.log('✅ Created worker_heartbeat table.');
    } else {
        // Check columns to ensure it matches strict requirement
        const cols = db.prepare("PRAGMA table_info(worker_heartbeat)").all();
        const hasWorkerName = cols.some(c => c.name === 'worker_name');

        if (!hasWorkerName) {
            console.log('⚠️  Table exists but schema mismatch (using old "name" pk?). Dropping and recreating...');
            db.exec("DROP TABLE worker_heartbeat");
            db.exec(`
                CREATE TABLE worker_heartbeat (
                    worker_name TEXT PRIMARY KEY,
                    last_seen TEXT NOT NULL,
                    status TEXT,
                    metadata TEXT
                );
            `);
            console.log('✅ Recreated worker_heartbeat table (Strict Schema).');
        } else {
            console.log('✅ worker_heartbeat table schema OK.');
        }
    }

} catch (error) {
    console.error('❌ Error in Observability Migration:', error.message);
    process.exit(1);
}

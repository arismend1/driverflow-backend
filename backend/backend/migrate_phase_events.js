const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log(`--- Migrating Phase Events: Schema Normalization [DB: ${process.env.DB_PATH || 'driverflow.db'}] ---`);

try {
    // 1. Ensure Table Exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS events_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            company_id INTEGER,
            driver_id INTEGER,
            request_id INTEGER,
            metadata TEXT,
            processed_at TEXT,
            process_status TEXT DEFAULT 'pending',
            last_error TEXT,
            send_attempts INTEGER DEFAULT 0
        )
    `);

    // 2. CHECK request_id NULLABILITY
    const columns = db.prepare("PRAGMA table_info(events_outbox)").all();
    const reqCol = columns.find(c => c.name === 'request_id');

    let needsRebuild = false;

    if (!reqCol) {
        console.log("WARN: request_id missing. Rebuild needed.");
        needsRebuild = true;
    } else if (reqCol.notnull === 1) {
        console.log("WARN: request_id is NOT NULL. Rebuild needed.");
        needsRebuild = true;
    } else {
        console.log("Check Passed: request_id exists and is NULLABLE.");
    }

    // 3. TABLE REBUILD (If needed)
    if (needsRebuild) {
        console.log("Starting Auto-Healing Table Rebuild...");
        db.transaction(() => {
            // A. Rename Old
            // Check if old table exists from failed run and drop it
            db.exec("DROP TABLE IF EXISTS events_outbox_old");
            db.exec("ALTER TABLE events_outbox RENAME TO events_outbox_old");

            // B. Create New (Explicitly Correct)
            db.exec(`
                CREATE TABLE events_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    company_id INTEGER,
                    driver_id INTEGER,
                    request_id INTEGER, -- Implicitly NULLABLE
                    metadata TEXT,
                    processed_at TEXT,
                    process_status TEXT DEFAULT 'pending',
                    last_error TEXT,
                    send_attempts INTEGER DEFAULT 0
                )
            `);

            // C. Detect & Add Extra Columns from Old
            const oldCols = db.prepare("PRAGMA table_info(events_outbox_old)").all();
            const newCols = db.prepare("PRAGMA table_info(events_outbox)").all().map(c => c.name);

            const extraCols = oldCols.filter(c => !newCols.includes(c.name));

            for (const col of extraCols) {
                console.log(`Preserving column: ${col.name} (${col.type})`);
                // Use double quotes for column name safety
                db.prepare(`ALTER TABLE events_outbox ADD COLUMN "${col.name}" ${col.type}`).run();
                newCols.push(col.name);
            }

            // D. Copy Data
            // Only copy columns that exist in both
            const commonCols = newCols.filter(c => oldCols.some(oc => oc.name === c.name));
            const colList = commonCols.map(c => `"${c}"`).join(', ');

            console.log(`Copying data columns: ${colList}`);
            db.prepare(`INSERT INTO events_outbox (${colList}) SELECT ${colList} FROM events_outbox_old`).run();

            // E. Drop Old
            db.exec("DROP TABLE events_outbox_old");
        })();
        console.log("Table Rebuild Complete.");
    }

    // 4. IDEMPOTENCY INDEX
    // Drop old index
    db.exec("DROP INDEX IF EXISTS idx_events_request_name");

    // Create Partial Index
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_request_name 
        ON events_outbox (request_id, event_name)
        WHERE request_id IS NOT NULL
    `);
    console.log("Index 'idx_events_request_name' verified.");

    // Final Verification
    const finalCols = db.prepare("PRAGMA table_info(events_outbox)").all();
    const finalReqCol = finalCols.find(c => c.name === 'request_id');
    if (finalReqCol && finalReqCol.notnull === 0) {
        console.log("FINAL CHECK PASSED: request_id is NULLABLE.");
    } else {
        console.error("FINAL CHECK FAILED: request_id is still NOT NULL or missing.");
        process.exit(1);
    }

} catch (error) {
    console.error("Migration Failed:", error.message);
    process.exit(1);
} finally {
    db.close();
}

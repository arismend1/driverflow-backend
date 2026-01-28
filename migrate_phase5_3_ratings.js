const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const db = new Database(DB_PATH);

console.log(`--- Migrating: Phase 5.3 Ratings on ${DB_PATH} ---`);

try {
    const run = db.transaction(() => {
        // 1. Create ratings table
        db.prepare(`
            CREATE TABLE IF NOT EXISTS ratings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                from_type TEXT NOT NULL CHECK (from_type IN ('empresa','driver')),
                from_id INTEGER NOT NULL,
                to_type TEXT NOT NULL CHECK (to_type IN ('empresa','driver')),
                to_id INTEGER NOT NULL,
                score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
                comment TEXT,
                created_at TEXT NOT NULL,
                CONSTRAINT uq_ticket_rater UNIQUE(ticket_id, from_type)
            )
        `).run();

        // 1.1 Check Schema Drift
        try {
            const rInfo = db.prepare("PRAGMA table_info(ratings)").all();

            const ensureColumn = (colName, colDef) => {
                if (!rInfo.find(c => c.name === colName)) {
                    db.prepare(`ALTER TABLE ratings ADD COLUMN ${colName} ${colDef}`).run();
                    console.log(`✅ Added missing ${colName} to ratings`);
                }
            };

            ensureColumn('ticket_id', 'INTEGER NOT NULL DEFAULT 0'); // Default needed for existing rows
            ensureColumn('from_type', "TEXT NOT NULL DEFAULT 'driver' CHECK (from_type IN ('empresa','driver'))");
            ensureColumn('from_id', 'INTEGER NOT NULL DEFAULT 0');
            ensureColumn('to_type', "TEXT NOT NULL DEFAULT 'empresa' CHECK (to_type IN ('empresa','driver'))");
            ensureColumn('to_id', 'INTEGER NOT NULL DEFAULT 0');
            ensureColumn('score', 'INTEGER NOT NULL DEFAULT 5 CHECK(score BETWEEN 1 AND 5)');
            ensureColumn('comment', 'TEXT');
            ensureColumn('created_at', "TEXT NOT NULL DEFAULT ''");

        } catch (e) { console.warn('Ignore schema check error:', e.message); }

        // 2. Indices
        try {
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_ratings_ticket ON ratings(ticket_id)`).run();
            db.prepare(`CREATE INDEX IF NOT EXISTS idx_ratings_target ON ratings(to_type, to_id)`).run();
        } catch (e) { console.warn('Index creation warning:', e.message); }

        console.log('✅ ratings table & indices synced.');
    });

    run();
    console.log('✅ Phase 5.3 Ratings Migration Complete');

} catch (err) {
    console.error('❌ Migration Failed:', err.message);
    process.exit(1);
}

const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const db = new Database(DB_PATH);

console.log(`--- Migrating: Phase 5 Post Hardening on ${DB_PATH} ---`);

try {
    const run = db.transaction(() => {
        // A) Admin Auth & Audit
        db.prepare(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin', -- admin, superadmin
                created_at TEXT NOT NULL
            )
        `).run();

        // Default Super Admin (password: 'AdminSecret123!') - ONLY if empty
        const count = db.prepare('SELECT count(*) as c FROM admin_users').get().c;
        if (count === 0) {
            // Hash for 'AdminSecret123!': $2b$10$NotReallyHashedHereUseLibInProd_ButForMVP_ClearOrSimpleHash
            // Prompt says "No dependencias nuevas". crypto.scrypt is native.
            // For MVP simplicity and requirements compliance ("SIN complicar"), we might store a known hash or handle it in app code.
            // Let's rely on server.js to seed if needed, or insert dummy here if we can.
            // We'll insert a placeholder and let endpoint logic verify against a fixed hash/secret if we want to avoid bcrypt dependency.
            // BETTER: Use `crypto` in server.js to hash.
            // Here just create table.
        }

        db.prepare(`
            CREATE TABLE IF NOT EXISTS admin_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_id INTEGER,
                action TEXT NOT NULL,
                target_resource TEXT,
                target_id TEXT,
                ip_address TEXT,
                timestamp TEXT NOT NULL
            )
        `).run();

        // B) Indices
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit_log(timestamp)`).run();

        // C) Rating Constraints (Refined)
        // Ensure constraints are strict (already done in 5.3 migration, but double check indices if needed)

        // D) Queue Optimizations
        // (Indices already added in 5.4)

    });

    run();
    console.log('✅ Phase 5 Post Migration Complete');

} catch (err) {
    console.error('❌ Migration Failed:', err.message);
    process.exit(1);
}

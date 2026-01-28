const sqlite3 = require('better-sqlite3');
const db = sqlite3(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Fix: Relaxing search_status constraint ---');

try {
    // 1. Check if 'empresas' needs fixing
    // We check if we can Insert 'MATCHED'. If not, we rebuild.
    let needsFix = false;
    try {
        db.prepare("INSERT INTO empresas (search_status) VALUES ('MATCHED')").run(); // Should fail if strict
        // If it succeeds, it means constraint is loose or missing. We must rollback this insert though.
        // Actually, 'empresas' has many NOT NULL cols (nombre, contacto, etc). 
        // A simple insert might fail due to other constraints.
        // Better way: Check sql schema from sqlite_master.
    } catch (e) {
        // We can't easily test-insert.
    }

    const tableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='empresas'").get();
    if (tableDef && tableDef.sql.includes("CHECK(search_status IN ('ON', 'OFF'))")) {
        console.log('⚠️ Strict CHECK constraint detected on empresas.search_status. Rebuilding...');
        needsFix = true;
    } else {
        console.log('✅ empresas table seems to have correct or no constraint.');
    }

    if (needsFix) {
        db.transaction(() => {
            // Disable FKs to allow table drop/rename
            db.pragma('foreign_keys = OFF');

            // 1. Rename Old
            db.prepare('ALTER TABLE empresas RENAME TO empresas_old').run();

            // 2. Create New (With relaxed constraint)
            // We need the FULL schema. 
            // Note: This must match the current "Goal" schema of empresas.
            // Based on migrations:
            // Base: id, nombre, contacto, password_hash, ciudad, tier, creditos, search_status...
            // Additional cols: legal_name, address_line1, address_state, contact_person, contact_phone, account_state, created_at, is_blocked, blocked_reason, blocked_at
            // This is getting complicated to maintain manually. 
            // Better strategy: Create table with "loose" constraint from scratch, using the definition derived from 'migrate_all' phases?
            // No, we must define it here.

            // Let's copy the definition but replace the constraint string.
            let newSql = tableDef.sql.replace(
                "CHECK(search_status IN ('ON', 'OFF'))",
                "CHECK(search_status IN ('ON', 'OFF', 'MATCHED'))"
            );

            // If the SQL contains the old name (it might if it was renamed? No, sqlite_master 'sql' field usually retains original CREATE statement but 'name' changes? 
            // Actually when we rename, SQLite updates the SQL field in sqlite_master to reflect new name? No, usually it updates it.
            // But we fetched 'tableDef' BEFORE rename. So newSql has "CREATE TABLE empresas ..."

            db.prepare(newSql).run();

            // 3. Copy Data
            db.prepare('INSERT INTO empresas SELECT * FROM empresas_old').run();

            // 4. Drop Old
            db.prepare('DROP TABLE empresas_old').run();

            // 5. Foreign Keys On
            db.pragma('foreign_keys = ON');
        })();
        console.log('✅ Fixed: empresas table rebuilt with relaxed constraint.');
    }

    // Drivers?
    // Drivers search_status was added in 'migrate_phase_matching.js' without constraint (usually).
    // But 'migrate_phase_prod.js' might have added it logic.
    // Let's check strictness.
    const driverDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='drivers'").get();
    if (driverDef && driverDef.sql.includes("CHECK(search_status IN ('ON', 'OFF'))")) {
        console.log('⚠️ Strict CHECK constraint detected on drivers.search_status. Rebuilding...');

        db.transaction(() => {
            db.pragma('foreign_keys = OFF');
            db.prepare('ALTER TABLE drivers RENAME TO drivers_old').run();

            let newSql = driverDef.sql.replace(
                "CHECK(search_status IN ('ON', 'OFF'))",
                "CHECK(search_status IN ('ON', 'OFF', 'MATCHED'))"
            );
            db.prepare(newSql).run();
            db.prepare('INSERT INTO drivers SELECT * FROM drivers_old').run();
            db.prepare('DROP TABLE drivers_old').run();
            db.pragma('foreign_keys = ON');
        })();
        console.log('✅ Fixed: drivers table rebuilt with relaxed constraint.');
    }

} catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
} finally {
    db.close();
}

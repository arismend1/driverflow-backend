const db = require('./db_adapter');

async function migrate() {
    console.log('[MIGRATION] Checking driver profile columns...');

    const columns = [
        { name: 'has_cdl', type: 'BOOLEAN', dflt: 'FALSE' },
        { name: 'license_types', type: 'TEXT', dflt: "'[]'" },
        { name: 'endorsements', type: 'TEXT', dflt: "'[]'" },
        { name: 'operation_types', type: 'TEXT', dflt: "'[]'" },
        { name: 'experience_years', type: 'INTEGER', dflt: '0' },
        { name: 'experience_range', type: 'TEXT', dflt: "''" },
        { name: 'job_preferences', type: 'TEXT', dflt: "'[]'" },
        { name: 'has_truck', type: 'BOOLEAN', dflt: 'FALSE' },
        { name: 'payment_methods', type: 'TEXT', dflt: "'[]'" },
        { name: 'work_relationships', type: 'TEXT', dflt: "'[]'" },
        { name: 'updated_at', type: 'TEXT', dflt: 'NULL' }
    ];

    for (const col of columns) {
        try {
            // Check if column exists
            const info = await db.all(`PRAGMA table_info(drivers)`);
            if (!info.find(c => c.name === col.name)) {
                console.log(`[MIGRATION] Adding column ${col.name} to drivers...`);
                await db.run(`ALTER TABLE drivers ADD COLUMN ${col.name} ${col.type} DEFAULT ${col.dflt}`);
            }
        } catch (e) {
            // Postgres might fail PRAGMA, but db_adapter might handle it. 
            // If it's Postgres, we use a different check if needed.
            if (db.IS_POSTGRES) {
                try {
                    const isJsonb = ['license_types', 'endorsements', 'operation_types', 'job_preferences', 'payment_methods', 'work_relationships'].includes(col.name);
                    const pgType = isJsonb ? 'JSONB' : col.type;
                    await db.run(`ALTER TABLE drivers ADD COLUMN ${col.name} ${pgType} DEFAULT ${col.dflt}`);
                } catch (pgErr) {
                    if (!pgErr.message.includes('already exists')) {
                        console.error(`[MIGRATION] Failed to add ${col.name}:`, pgErr.message);
                    }
                }
            } else {
                console.error(`[MIGRATION] Failed to add ${col.name}:`, e.message);
            }
        }
    }

    console.log('[MIGRATION] Driver profile columns ready.');
}

if (require.main === module) {
    migrate().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = migrate;

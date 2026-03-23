const db = require('../db_adapter');

(async () => {
    try {
        console.log('--- Inspecting empresas table ---');
        if (db.IS_POSTGRES) {
            const res = await db.all(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = 'empresas'
            `);
            console.log('PostgreSQL Columns:', res);
        } else {
            const res = await db.all("PRAGMA table_info(empresas)");
            console.log('SQLite Columns:', res);
        }
        process.exit(0);
    } catch (err) {
        console.error('Failed to inspect table:', err.message);
        process.exit(1);
    }
})();

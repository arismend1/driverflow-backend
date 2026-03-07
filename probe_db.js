const db = require('./db_adapter');

async function probe() {
    console.log(`--- DB Probe ---`);
    console.log(`Engine: ${db.IS_POSTGRES ? 'POSTGRES' : 'SQLITE'}`);

    const tables = ['drivers', 'empresas'];
    for (const table of tables) {
        console.log(`\nChecking ${table}...`);
        try {
            if (db.IS_POSTGRES) {
                const cols = await db.all(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = ? 
                    ORDER BY ordinal_position
                `, table);
                console.log("Columns:", cols.map(c => c.column_name).join(', '));
            } else {
                const cols = await db.all(`PRAGMA table_info(${table})`);
                console.log("Columns:", cols.map(c => c.name).join(', '));
            }
        } catch (e) {
            console.error(`Error probing ${table}:`, e.message);
        }
    }
    db.close();
}

probe().catch(console.error);

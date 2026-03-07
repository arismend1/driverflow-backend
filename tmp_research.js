const db = require('./db_adapter');

async function run() {
    try {
        console.log('--- Companies with contacto="luxuryservicesfl@gmail.com" ---');
        try {
            const companies = await db.all(`
                SELECT id, nombre, contacto, created_at, account_state, verified 
                FROM empresas 
                WHERE contacto = 'luxuryservicesfl@gmail.com' 
                ORDER BY id
            `);
            console.table(companies);
        } catch (e) {
            console.error('Error querying empresas:', e.message);
            // Fallback for potentially different column names
            const fallback = await db.all(`SELECT * FROM empresas WHERE contacto = 'luxuryservicesfl@gmail.com' ORDER BY id`);
            console.table(fallback);
        }

        console.log('\n--- Match 136252 details ---');
        try {
            const matches = await db.all(`
                SELECT id, company_id, driver_id, status 
                FROM potential_matches 
                WHERE id = 136252
            `);
            console.table(matches);
        } catch (e) {
            console.error('Error querying potential_matches:', e.message);
        }

    } catch (err) {
        console.error('Fatal research error:', err);
    } finally {
        if (db.close) db.close();
    }
}

run();

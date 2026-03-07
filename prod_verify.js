const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false
});

async function run() {
    try {
        console.log("--- Production Research ---");
        const resEmp = await pool.query(`
            SELECT id, nombre, contacto, created_at, account_state, verified 
            FROM empresas 
            WHERE LOWER(TRIM(contacto)) = LOWER(TRIM('luxuryservicesfl@gmail.com')) 
            ORDER BY id;
        `);
        console.log("Duplicate Companies:");
        console.table(resEmp.rows);

        const resMatch = await pool.query(`
            SELECT id, company_id, driver_id, status 
            FROM potential_matches 
            WHERE id = 136252;
        `);
        console.log("Match 136252:");
        console.table(resMatch.rows);

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

run();

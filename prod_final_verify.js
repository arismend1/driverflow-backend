const { Pool } = require('pg');

const connectionString = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log('--- START PRODUCTION QUERY ---');

        const resEmp = await pool.query(`
            SELECT id, nombre, contacto, created_at, account_state, verified 
            FROM empresas 
            WHERE LOWER(TRIM(contacto)) = LOWER(TRIM('luxuryservicesfl@gmail.com')) 
            ORDER BY id;
        `);
        console.log('DUPLICATE_COMPANIES_START');
        console.log(JSON.stringify(resEmp.rows, null, 2));
        console.log('DUPLICATE_COMPANIES_END');

        const resMatch = await pool.query(`
            SELECT id, company_id, driver_id, status 
            FROM potential_matches 
            WHERE id = 136252;
        `);
        console.log('MATCH_136252_START');
        console.log(JSON.stringify(resMatch.rows, null, 2));
        console.log('MATCH_136252_END');

        console.log('--- END PRODUCTION QUERY ---');
        process.exit(0);
    } catch (err) {
        console.error('PROD_QUERY_ERROR:', err.message);
        process.exit(1);
    }
}

run();

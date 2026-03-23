const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("--- [PRODUCTION] VERIFYING verification_status COLUMN ---");
        
        const verifySql = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'empresas' AND column_name = 'verification_status'";
        const res = await pool.query(verifySql);
        
        if (res.rows.length > 0) {
            console.log("✅ Column verification_status exists.");
            console.log("Info:", res.rows[0]);
            
            const dataSql = "SELECT id, nombre, verification_status FROM empresas LIMIT 5";
            const dataRes = await pool.query(dataSql);
            console.log("Data check (first 5 rows):", dataRes.rows);
        } else {
            console.log("❌ Column does NOT exist.");
        }

    } catch (e) {
        console.error("POSTGRES ERROR:", e.message);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

run();

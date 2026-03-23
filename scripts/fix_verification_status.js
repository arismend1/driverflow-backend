const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("--- [PRODUCTION] ADDING verification_status COLUMN ---");
        
        // Step 1: Add the column
        const sql = "ALTER TABLE empresas ADD COLUMN verification_status TEXT DEFAULT 'approved'";
        console.log(`Executing: ${sql}`);
        await pool.query(sql);
        console.log("✅ Column created successfully.");

        // Step 2: Verify
        const verifySql = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'empresas' AND column_name = 'verification_status'";
        const res = await pool.query(verifySql);
        console.log("Verification info:", res.rows);

        // Step 3: Check data
        const dataSql = "SELECT id, nombre, verification_status FROM empresas LIMIT 5";
        const dataRes = await pool.query(dataSql);
        console.log("Data check (first 5 rows):", dataRes.rows);

    } catch (e) {
        console.error("POSTGRES ERROR:", e.message);
        if (e.message.includes('already exists')) {
            console.log("⏭️ Skipping: Column already exists.");
        }
    } finally {
        await pool.end();
        process.exit(0);
    }
}

run();

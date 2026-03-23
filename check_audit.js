const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("=== AUDIT LOG CHECK ===");
        const res = await pool.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 20");
        res.rows.forEach(r => {
            console.log(`[${r.created_at}] ${r.action} - Actor:${r.actor_id} - Target:${r.target_id} - Meta:${r.metadata}`);
        });
    } catch (e) {
        console.error("Audit Error:", e);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

run();

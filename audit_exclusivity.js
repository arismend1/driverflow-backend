const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("=== EXCLUSIVITY AUDIT (READ-ONLY) ===");
        
        // 1. Duplicated INFO_SHARED
        const dupes = await pool.query(`
            SELECT driver_id, COUNT(*) as count 
            FROM potential_matches 
            WHERE status = 'INFO_SHARED' 
            GROUP BY driver_id 
            HAVING COUNT(*) > 1
        `);
        console.log("\n[Audit A] Drivers with multiple INFO_SHARED matches:", dupes.rows.length);
        if (dupes.rows.length > 0) {
            console.log("Affected Driver IDs:", dupes.rows.map(r => r.driver_id).join(', '));
        }

        // 2. Stale INFO_SHARED (> 72h)
        const stale = await pool.query(`
            SELECT id, driver_id, info_shared_at 
            FROM potential_matches 
            WHERE status = 'INFO_SHARED' 
              AND (EXTRACT(EPOCH FROM (NOW() - info_shared_at)) / 3600) > 72
        `);
        console.log("\n[Audit B] INFO_SHARED matches older than 72h:", stale.rows.length);

        // 3. Active Handshakes
        const handshakes = await pool.query(`
            SELECT status, COUNT(*) as count 
            FROM potential_matches 
            WHERE status IN ('SHARE_PENDING_COMPANY', 'SHARE_PENDING_DRIVER') 
            GROUP BY status
        `);
        console.log("\n[Audit C] Active Handshakes:");
        handshakes.rows.forEach(r => console.log(`- ${r.status}: ${r.count}`));

    } catch (e) {
        console.error("Audit Error:", e);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

run();

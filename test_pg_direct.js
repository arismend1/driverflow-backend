const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("Testing integer <> text comparison...");
        // This will simulate the reactive closure query
        const sql = "SELECT id FROM potential_matches WHERE id <> $1 LIMIT 1";
        const res = await pool.query(sql, ["123"]); 
        console.log("Success! Postgres auto-casts text to integer for <> comparison.");
        console.log("Result count:", res.rows.length);

        console.log("\nTesting potential_matches.driver_id type...");
        const res2 = await pool.query("SELECT driver_id FROM potential_matches LIMIT 1");
        console.log("Column value type:", typeof res2.rows[0].driver_id);

    } catch (e) {
        console.error("POSTGRES ERROR:", e.message);
        console.error("CODE:", e.code);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

run();

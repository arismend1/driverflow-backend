const { Client } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const client = new Client({
    connectionString: DB_URL,
    ssl: { 
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
});

async function run() {
    try {
        console.log("Connecting to production DB...");
        await client.connect();
        console.log("Connected! Applying ALTER TABLE...");
        
        await client.query("ALTER TABLE empresas ADD COLUMN verification_status TEXT DEFAULT 'approved'");
        console.log("✅ SQL Executed: ALTER TABLE empresas ADD COLUMN verification_status TEXT DEFAULT 'approved'");

        const check = await client.query("SELECT verification_status FROM empresas LIMIT 5");
        console.log("✅ Verification check success. Sample data:", check.rows);

    } catch (e) {
        console.error("POSTGRES ERROR:", e.message);
        if (e.message.includes("already exists")) {
            console.log("⏭️ Skipping: Column already exists.");
        }
    } finally {
        await client.end();
        process.exit(0);
    }
}

run();

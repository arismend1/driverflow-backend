const { Client } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("Connecting...");
        await client.connect();
        console.log("Connected! Running query...");
        const res = await client.query('SELECT 1 as result');
        console.log("Result:", res.rows[0].result);
    } catch (e) {
        console.error("ERROR:", e.message);
    } finally {
        await client.end();
        process.exit(0);
    }
}

run();

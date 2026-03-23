require('dotenv').config();
const { Client } = require('pg');

const url = process.env.DATABASE_URL;

async function runQueries() {
    console.log("Connecting to Render DB...");
    const client = new Client({
        connectionString: url,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log("Connected!");

        console.log("\n--- events_outbox ---");
        const res1 = await client.query("SELECT id,event_name,company_id,driver_id,queue_status,metadata,created_at FROM events_outbox ORDER BY id DESC LIMIT 10;");
        console.table(res1.rows);

        console.log("\n--- jobs_queue ---");
        const res2 = await client.query("SELECT id,job_type,status,attempts,last_error,run_at FROM jobs_queue ORDER BY id DESC LIMIT 10;");
        console.table(res2.rows);

    } catch (e) {
        console.error("DB Error:", e.message);
    } finally {
        await client.end();
    }
}
runQueries();

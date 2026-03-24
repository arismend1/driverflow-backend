const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function runAudit() {
    try {
        console.log("--- TICKETS (Last 20) ---");
        const res1 = await pool.query("SELECT * FROM tickets ORDER BY created_at DESC LIMIT 20");
        console.table(res1.rows);

        console.log("\n--- INVOICES (Last 20) ---");
        const res2 = await pool.query("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 20");
        console.table(res2.rows);

        console.log("\n--- INVOICES (Manual Audit) ---");
        try {
            const res3 = await pool.query("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 20");
            console.table(res3.rows);
        } catch (e) {
            console.log("Table 'invoices' does not exist or failed:", e.message);
        }

        console.log("\n--- TICKET STATUS COUNTS ---");
        const res4 = await pool.query("SELECT billing_status, count(*) FROM tickets GROUP BY billing_status");
        console.table(res4.rows);

        console.log("\n--- TICKETS 16 & 18 ---");
        const res5 = await pool.query("SELECT id, billing_status, created_at, company_id FROM tickets WHERE id IN (16, 18)");
        console.table(res5.rows);

        console.log("\n--- RELATIONSHIP (16 & 18) ---");
        const res6 = await pool.query(`
            SELECT ii.invoice_id, ii.ticket_id, i.status, i.created_at as invoice_created
            FROM invoice_items ii
            JOIN invoices i ON ii.invoice_id = i.id
            WHERE ii.ticket_id IN (16, 18)
        `);
        console.table(res6.rows);

        console.log("\n--- WORKER HEARTBEAT ---");
        const res7 = await pool.query("SELECT * FROM worker_heartbeat");
        console.table(res7.rows);

        console.log("\n--- LATEST JOBS ---");
        const res8 = await pool.query("SELECT id, job_type, status, attempts, last_error, run_at FROM jobs_queue ORDER BY id DESC LIMIT 10");
        console.table(res8.rows);

    } catch (e) {
        console.error("AUDIT FAILED:", e.message);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

runAudit();

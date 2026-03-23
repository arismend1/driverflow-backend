const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        
        console.log("--- INVICES ---");
        const invRes = await client.query(`
            SELECT id, company_id, billing_week, issue_date, status, total_cents
            FROM invoices
            ORDER BY id DESC
            LIMIT 5
        `);
        console.table(invRes.rows);

        console.log("\n--- TICKETS ---");
        const tktRes = await client.query(`
            SELECT id, company_id, driver_id, match_id, billing_status, created_at, updated_at
            FROM tickets
            ORDER BY id DESC
            LIMIT 10
        `);
        console.table(tktRes.rows);

    } catch(e) { console.error(e); } finally { await client.end(); }
}
run();

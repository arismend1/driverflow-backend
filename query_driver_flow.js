const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        
        console.log("--- DRIVER RECORD ---");
        const drv = await client.query("SELECT id, nombre, status, search_status FROM drivers WHERE nombre = 'Driver Flow'");
        console.table(drv.rows);

        if (drv.rows.length > 0) {
            const drvId = drv.rows[0].id;
            
            console.log("--- POTENTIAL MATCHES ---");
            const matches = await client.query(`SELECT id, company_id, status, ticket_id FROM potential_matches WHERE driver_id = $1`, [drvId]);
            console.table(matches.rows);

            console.log("--- TICKETS ---");
            const tickets = await client.query(`SELECT id, company_id, match_id, request_id, billing_status, created_at FROM tickets WHERE driver_id = $1`, [drvId]);
            console.table(tickets.rows);
        }
    } catch (e) {
        console.error("Error:", e.message);
    } finally {
        await client.end();
    }
}
run();

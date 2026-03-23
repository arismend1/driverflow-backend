const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        
        console.log("--- ALL INVOICES ---");
        const invoices = await client.query("SELECT * FROM invoices ORDER BY created_at DESC;");
        console.table(invoices.rows);
    } catch (e) {
        console.error("Error:", e.message);
    } finally {
        await client.end();
    }
}
run();

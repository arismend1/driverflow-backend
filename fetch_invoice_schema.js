const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        const schemaRes = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'invoices'
        `);
        console.table(schemaRes.rows);
    } catch(e) { console.error(e); } finally { await client.end(); }
}
run();

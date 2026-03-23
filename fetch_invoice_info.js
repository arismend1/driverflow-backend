const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        const companiesRes = await client.query(`SELECT id, nombre FROM empresas WHERE nombre IN ('Luxury Services', 'Ram Services Pro')`);
        console.table(companiesRes.rows);

        const invoicesRes = await client.query(`SELECT id, company_id, billing_week, status, total_cents FROM invoices WHERE billing_week = '2026-03-09 to 2026-03-15'`);
        console.table(invoicesRes.rows);
    } catch(e) { console.error(e); } finally { await client.end(); }
}
run();

const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    await client.connect();
    try {
        const res = await client.query('SELECT id, status, paid_at FROM invoices WHERE id = 2');
        console.table(res.rows);
    } catch(e) {
        console.error(e.message);
    }
    await client.end();
}
run();

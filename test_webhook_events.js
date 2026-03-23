const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    await client.connect();
    try {
        const res = await client.query("SELECT * FROM stripe_webhook_events WHERE stripe_event_id = 'evt_1TBoVAQ82yOl eCP30W6Vq6YS' OR type='checkout.session.completed' ORDER BY created_at DESC LIMIT 5");
        console.table(res.rows);
    } catch(e) {
        console.error(e.message);
    }
    await client.end();
}
run();

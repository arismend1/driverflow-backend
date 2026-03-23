const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        const res = await client.query('SELECT type, payload FROM stripe_webhook_events LIMIT 1');
        if (res.rows.length > 0) {
            const j = JSON.parse(res.rows[0].payload);
            console.log("Stripe environment from webhook events: " + (j.livemode ? "LIVE" : "TEST"));
        } else {
            console.log("NO EVENTS");
        }
    } catch(e) { console.error(e); } finally { await client.end(); }
}
run();

const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        const company_id = 7; 
        const week_start = '2026-03-09';
        const week_end = '2026-03-15';
        
        let endPlusOne;
        try {
            const d = new Date(week_end);
            d.setDate(d.getDate() + 1);
            endPlusOne = d.toISOString().split('T')[0];
        } catch (e) { endPlusOne = week_end; }

        const usageRes = await client.query(`
            SELECT count(*) as cnt, count(distinct driver_id) as drv 
            FROM tickets 
            WHERE company_id = $1 AND created_at >= $2 AND created_at < $3 AND billing_status != 'void'`,
            [company_id, week_start, endPlusOne]
        );
        const usage = usageRes.rows[0];

        const total = usage ? (parseInt(usage.cnt) || 0) : 0;
        const amount = total * 15000;

        const billing_week = `${week_start} to ${week_end}`;
        const issueDate = new Date();
        const dueDate = new Date(issueDate);
        dueDate.setDate(dueDate.getDate() + 7);

        console.log(JSON.stringify({
            company_id,
            billing_week,
            issue_date: issueDate.toISOString(),
            due_date: dueDate.toISOString(),
            subtotal_cents: amount,
            total_cents: amount,
            currency: 'USD',
            status: 'pending'
        }, null, 2));

    } catch (e) {
        console.error("Simulation failed:", e.message);
    } finally {
        await client.end();
    }
}
run();

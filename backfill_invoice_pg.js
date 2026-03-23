const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

const nowIso = () => new Date().toISOString();

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

        console.log(`Calculating usage for Company ${company_id} between ${week_start} and ${endPlusOne}`);

        const usageRes = await client.query(`
            SELECT count(*) as cnt, count(distinct driver_id) as drv 
            FROM tickets 
            WHERE company_id = $1 AND created_at >= $2 AND created_at < $3 AND billing_status != 'void'`,
            [company_id, week_start, endPlusOne]
        );
        const usage = usageRes.rows[0];

        const total = usage ? (parseInt(usage.cnt) || 0) : 0;
        const amount = total * 15000;

        console.log(`Total tickets: ${total}. Amount to bill: $${amount / 100}`);

        if (total === 0) {
            console.log("No tickets found. Exiting safe.");
            return;
        }

        const billing_week = `${week_start} to ${week_end}`;
        const issueDate = new Date();
        const dueDate = new Date(issueDate);
        dueDate.setDate(dueDate.getDate() + 7);

        console.log(`Inserting Invoice: ${billing_week}`);
        const insertRes = await client.query(
            `INSERT INTO invoices (
                company_id, 
                billing_week, 
                issue_date, 
                due_date, 
                subtotal_cents, 
                total_cents, 
                currency, 
                status, 
                created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'USD', 'pending', $7) RETURNING *`,
            [
                company_id, 
                billing_week, 
                issueDate.toISOString(), 
                dueDate.toISOString(), 
                amount, 
                amount, 
                nowIso()
            ]
        );

        console.log("Invoice Inserted!");
        console.table(insertRes.rows);
    } catch (e) {
        console.error("Backfill failed:", e.message);
    } finally {
        await client.end();
    }
}
run();

const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        
        await client.query('BEGIN');

        await client.query(`
            UPDATE invoices
            SET status = 'void'
            WHERE company_id = 7
            AND billing_week = '2026-03-09 to 2026-03-15'
            AND status = 'pending';
        `);

        await client.query(`
            INSERT INTO invoices (
                company_id,
                billing_week,
                issue_date,
                due_date,
                subtotal_cents,
                total_cents,
                currency,
                status,
                created_at
            )
            SELECT
                6,
                '2026-03-09 to 2026-03-15',
                NOW(),
                NOW() + INTERVAL '7 days',
                15000,
                15000,
                'USD',
                'pending',
                NOW()
            WHERE NOT EXISTS (
                SELECT 1
                FROM invoices
                WHERE company_id = 6
                AND billing_week = '2026-03-09 to 2026-03-15'
                AND status IN ('pending', 'paid')
            );
        `);

        await client.query('COMMIT');

        console.log("Transaction committed successfully.\n");

        console.log("--- FINAL RESULTS ---");
        const res = await client.query(`
            SELECT id, company_id, billing_week, status, total_cents
            FROM invoices
            WHERE billing_week = '2026-03-09 to 2026-03-15'
            ORDER BY company_id, id;
        `);
        console.table(res.rows);

    } catch(e) { 
        console.error(e); 
        await client.query('ROLLBACK');
    } finally { 
        await client.end(); 
    }
}
run();

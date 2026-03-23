const db = require('./db_adapter');

const nowIso = () => new Date().toISOString();

async function backfillWeeklyInvoice() {
    console.log("Starting Backfill...");
    try {
        const company_id = 7; // The company from the example
        // The week of interest from the discussion/logs: Mon Mar 9 to Sun Mar 15
        const week_start = '2026-03-09';
        const week_end = '2026-03-15';
        
        let endPlusOne;
        try {
            const d = new Date(week_end);
            d.setDate(d.getDate() + 1);
            endPlusOne = d.toISOString().split('T')[0];
        } catch (e) { endPlusOne = week_end; }

        console.log(`Calculating usage for Company ${company_id} between ${week_start} and ${endPlusOne}`);
        
        const usage = await db.get(`
            SELECT count(*) as cnt, count(distinct driver_id) as drv 
            FROM tickets 
            WHERE company_id = ? AND created_at >= ? AND created_at < ? AND billing_status != 'void'`,
            company_id, week_start, endPlusOne
        );

        const total = usage ? (usage.cnt || 0) : 0;
        const drivers = usage ? (usage.drv || 0) : 0;
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
        await db.run(
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
            ) VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending', ?)`,
            company_id, 
            billing_week, 
            issueDate.toISOString(), 
            dueDate.toISOString(), 
            amount, 
            amount, 
            nowIso()
        );

        console.log("Invoice Inserted!");
    } catch (e) {
        console.error("Backfill failed:", e.message);
    }
}

backfillWeeklyInvoice();

require('dotenv').config();
const db = require('./db_adapter');

async function regen() {
    try {
        console.log("--- 1. Fetching Tickets for Company 3 ---");
        const tickets = await db.all("SELECT id, company_id, created_at, billing_status FROM tickets WHERE company_id=3 AND billing_status != 'void'");
        console.log(tickets);

        if (tickets.length === 0) {
            console.log("No tickets found.");
            return;
        }

        // Determine billing week from the first ticket
        const created_at = new Date(tickets[0].created_at);
        const day = created_at.getDay(); // 0-6 (Sun-Sat)
        const diffToMon = (day + 6) % 7;
        const thisMon = new Date(created_at);
        thisMon.setDate(created_at.getDate() - diffToMon);
        thisMon.setHours(0, 0, 0, 0);

        const week_start = thisMon.toISOString().split('T')[0];

        const prevSun = new Date(thisMon);
        prevSun.setDate(thisMon.getDate() + 6);
        const week_end = prevSun.toISOString().split('T')[0];

        console.log(`\n--- 2. Derived Billing Week: ${week_start} to ${week_end} ---`);

        // Run the EXACT logic from worker_queue.js
        let start = week_start;
        let endPlusOne;
        const d = new Date(week_end);
        d.setDate(d.getDate() + 1);
        endPlusOne = d.toISOString().split('T')[0];

        const usage = await db.get(`
            SELECT count(*) as cnt, count(distinct driver_id) as drv 
            FROM tickets 
            WHERE company_id = ? AND created_at >= ? AND created_at < ? AND billing_status != 'void'`,
            3, start, endPlusOne
        );

        const total = usage ? (usage.cnt || 0) : 0;
        const drivers = usage ? (usage.drv || 0) : 0;
        const PRICE_PER_TICKET_CENTS = 15000;
        const amount = total * PRICE_PER_TICKET_CENTS;

        console.log(`\n--- 3. Calculated Totals ---`);
        console.log(`Tickets (cnt): ${total}`);
        console.log(`Drivers (drv): ${drivers}`);
        console.log(`Amount (cents): ${amount}`);

        // Insert Invoice
        await db.run(`INSERT INTO invoices (company_id, week_start, week_end, total_requests, active_drivers, total_cents, currency, status, created_at) VALUES (?,?,?,?,?,?,'USD','pending',?)`,
            3, week_start, week_end, total, drivers, amount, new Date().toISOString());

        console.log(`\n--- 4. Final DB State ---`);
        const inv = await db.get("SELECT id, company_id, week_start, week_end, total_cents, currency, status FROM invoices WHERE company_id=3");
        console.log(inv);

    } catch (e) {
        console.error("Error:", e);
    } finally {
        process.exit(0);
    }
}

regen();

/**
 * SURGICAL FIX: NORMALIZE TICKET STATUS
 * Converts 'unpaid' and 'billable' tickets to 'unbilled' 
 * to ensure the weekly invoice worker picks them up correctly.
 */
require('dotenv').config();
const db = require('../db_adapter');

async function normalize() {
    console.log("--- Normalizing Ticket Statuses ---");
    try {
        await db.beginTransaction();

        // 1. Identify counts before
        const countsBefore = await db.all("SELECT billing_status, count(*) as c FROM tickets GROUP BY billing_status");
        console.log("Current states:", countsBefore);

        // 2. Perform updates
        // Convert 'unpaid' -> 'unbilled'
        const res1 = await db.run("UPDATE tickets SET billing_status = 'unbilled' WHERE billing_status = 'unpaid'");
        console.log(`Updated ${res1.changes || '?' } 'unpaid' tickets to 'unbilled'.`);

        // Convert 'billable' -> 'unbilled'
        const res2 = await db.run("UPDATE tickets SET billing_status = 'unbilled' WHERE billing_status = 'billable'");
        console.log(`Updated ${res2.changes || '?' } 'billable' tickets to 'unbilled'.`);

        // 3. Verify
        const countsAfter = await db.all("SELECT billing_status, count(*) as c FROM tickets GROUP BY billing_status");
        console.log("Final states:", countsAfter);

        await db.commit();
        console.log("✅ Success! Tickets normalized.");
    } catch (e) {
        await db.rollback();
        console.error("❌ Normalization FAILED:", e.message);
        process.exit(1);
    } finally {
        process.exit(0);
    }
}

normalize();

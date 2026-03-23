/**
 * SURGICAL FIX: NORMALIZE TICKET STATUS
 * Converts 'unpaid' and 'billable' tickets to 'unbilled' 
 * to ensure the weekly invoice worker picks them up correctly.
 */
require('dotenv').config();
const db = require('../db_adapter');

async function normalize() {
    console.log("--- Normalizing Ticket Statuses ---");
    let tx;
    try {
        tx = await db.beginTransaction();

        // 1. Identify counts before
        const countsBefore = await tx.get("SELECT COUNT(*) as unpaid FROM tickets WHERE billing_status = 'unpaid'");
        const countsBillable = await tx.get("SELECT COUNT(*) as billable FROM tickets WHERE billing_status = 'billable'");
        console.log("Current states - Unpaid:", countsBefore.unpaid, "Billable:", countsBillable.billable);

        // 2. Perform updates
        // Convert 'unpaid' -> 'unbilled'
        const res1 = await tx.run("UPDATE tickets SET billing_status = 'unbilled' WHERE billing_status = 'unpaid'");
        console.log(`Updated 'unpaid' tickets to 'unbilled'.`);

        // Convert 'billable' -> 'unbilled'
        const res2 = await tx.run("UPDATE tickets SET billing_status = 'unbilled' WHERE billing_status = 'billable'");
        console.log(`Updated 'billable' tickets to 'unbilled'.`);

        // 3. Verify
        const countsAfter = await tx.get("SELECT billing_status, count(*) as c FROM tickets GROUP BY billing_status");
        // tx.get returns one row, need all? My adapter tx has no all().
        // I'll just commit and check with db.all
        
        await tx.commit();
        console.log("Transaction committed.");
        
        const countsFinal = await db.all("SELECT billing_status, count(*) as c FROM tickets GROUP BY billing_status");
        console.log("Final states:", countsFinal);

        console.log("✅ Success! Tickets normalized.");
    } catch (e) {
        if (tx) await tx.rollback();
        console.error("❌ Normalization FAILED:", e.message);
        process.exit(1);
    } finally {
        process.exit(0);
    }
}

normalize();

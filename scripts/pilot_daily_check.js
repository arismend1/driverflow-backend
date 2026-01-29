/**
 * PILOT DAILY CHECK SCRIPT
 * Usage: node scripts/pilot_daily_check.js
 * 
 * Runs specific SQL queries to report on the 5 Key Pilot Metrics
 * and System Health stats.
 */

const db = require('better-sqlite3')('./driverflow.db');

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const yesterday = new Date(now.getTime() - DAY_MS).toISOString();

console.log(`\n📊 DRIVERFLOW PILOT STATUS REPORT`);
console.log(`📅 Date: ${now.toISOString()}`);
console.log(`---------------------------------`);

try {
    // 1. New Registrations (Last 24h)
    const newDrivers = db.prepare("SELECT count(*) as c FROM drivers WHERE created_at > ?").get(yesterday).c;
    const newCompanies = db.prepare("SELECT count(*) as c FROM empresas WHERE created_at > ?").get(yesterday).c;

    console.log(`\n1️⃣  GROWTH (Last 24h)`);
    console.log(`   - New Drivers: ${newDrivers}`);
    console.log(`   - New Companies: ${newCompanies}`);

    // 2. Matching Activity
    const totalMatches = db.prepare("SELECT count(*) as c FROM matches").get().c;
    // Assuming 'created_at' exists on matches (if not, we check total vs yesterday if we persisted history, strictly we verify presence)
    // Matches table might not have created_at in some migrations, checking schema...
    // Only 'driver_id', 'company_id', 'match_score', etc. based on previous interaction.
    // If no timestamp, we report Total.
    console.log(`\n2️⃣  MATCHING ENGINE`);
    console.log(`   - Total Matches Active: ${totalMatches}`);

    // 3. Tickets & Conversion (Phase 8 placeholder)
    // const tickets = db.prepare("SELECT count(*) as c FROM tickets WHERE created_at > ?").get(yesterday).c;
    console.log(`\n3️⃣  CONVERSION`);
    console.log(`   - Tickets/Payments: (Not verified in this script version)`);

    // 4. Queue Health (SRE)
    const pendingEvents = db.prepare("SELECT count(*) as c FROM events_outbox WHERE queue_status = 'pending'").get().c;
    const failedEvents = db.prepare("SELECT count(*) as c FROM events_outbox WHERE queue_status = 'failed'").get().c;
    const deadEvents = db.prepare("SELECT count(*) as c FROM events_outbox WHERE queue_status = 'dead_letter'").get().c;

    console.log(`\n4️⃣  SYSTEM HEALTH (Event Queue)`);
    console.log(`   - Pending: ${pendingEvents} ${pendingEvents > 10 ? '⚠️ High Load' : '✅ OK'}`);
    console.log(`   - Failed:  ${failedEvents} ${failedEvents > 0 ? '⚠️ Check Logs' : '✅ Clean'}`);
    console.log(`   - Dead:    ${deadEvents}`);

    // 5. Worker Heartbeat
    try {
        const heartbeat = db.prepare("SELECT * FROM worker_heartbeat ORDER BY last_beat DESC LIMIT 1").get();
        if (heartbeat) {
            const beatTime = new Date(heartbeat.last_beat).getTime();
            const diffMin = (now.getTime() - beatTime) / 60000;
            console.log(`\n5️⃣  WORKER STATUS`);
            console.log(`   - Last Beat: ${Math.round(diffMin)} mins ago (${heartbeat.worker_id})`);
            if (diffMin > 10) console.log("   ❌ ALERT: Worker might be down!");
            else console.log("   ✅ Worker Active");
        } else {
            console.log("\n5️⃣  WORKER STATUS: No heartbeat found.");
        }
    } catch (e) {
        console.log("\n5️⃣  WORKER STATUS: Table not found or empty.");
    }

    console.log(`\n---------------------------------`);
    console.log(`END OF REPORT`);

} catch (err) {
    console.error("❌ REPORT FAILED:", err.message);
}

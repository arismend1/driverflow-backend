const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const SRC_DB = 'driverflow.db';
const SIM_DB = 'driverflow_sim_45d.db';
const SIM_STATE_FILE = path.resolve(__dirname, '../sim_time_state.json'); // Parent dir of scripts/

// Ensure clean state
if (fs.existsSync(SIM_DB)) fs.unlinkSync(SIM_DB);
fs.copyFileSync(SRC_DB, SIM_DB);

// Backup original sim state if exists
let originalState = null;
if (fs.existsSync(SIM_STATE_FILE)) {
    originalState = fs.readFileSync(SIM_STATE_FILE, 'utf-8');
}

// Helper to set sim time offset
function setSimTimeOffset(minutes) {
    fs.writeFileSync(SIM_STATE_FILE, JSON.stringify({ offset_minutes: minutes }, null, 2));
}

function restoreSimState() {
    if (originalState) {
        fs.writeFileSync(SIM_STATE_FILE, originalState);
    } else if (fs.existsSync(SIM_STATE_FILE)) {
        fs.unlinkSync(SIM_STATE_FILE);
    }
}

// ISO week helper
function getWeekLabel(date) {
    const target = new Date(date.valueOf());
    const dayNr = (date.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
        target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    const weekNumber = 1 + Math.ceil((firstThursday - target) / 604800000);
    const year = target.getFullYear();
    return `${year}-${String(weekNumber).padStart(2, '0')}`;
}

const WEEKS_TO_SIMULATE = 7;
const SIM_SCALE = 60; // 1 real min = 60 sim mins (irrelevant for manual offset but good context)
const ONE_WEEK_MINUTES = 7 * 24 * 60;

console.log(`\n=================================================`);
console.log(`🚀 STARTING 45-DAY BILLING SIMULATION`);
console.log(`=================================================`);
console.log(`DB: ${SIM_DB}`);
console.log(`Mode: Time Travel via sim_time_state.json`);

try {
    const db = new Database(SIM_DB);
    let currentOffset = 0;

    for (let i = 0; i < WEEKS_TO_SIMULATE; i++) {
        // 1. Advance Time
        const simDate = new Date(Date.now() + (currentOffset * 60 * 1000));
        const weekLabel = getWeekLabel(simDate);

        console.log(`\n📅 WEEK ${i + 1}: ${weekLabel} (Sim Date: ${simDate.toISOString().split('T')[0]})`);

        // Update global sim state so the other script sees it
        setSimTimeOffset(currentOffset);

        // 2. Run Invoice Generation
        // We close DB connection briefly to avoid any potential locking issues with the external process
        // although better-sqlite3 + execSync usually works if not concurrent.
        db.close();

        try {
            console.log(`   ⚙️ Running Billing...`);
            execSync(`node generate_weekly_invoices.js ${weekLabel}`, {
                stdio: 'pipe',
                env: { ...process.env, DB_PATH: SIM_DB, SIM_TIME: '1' }
            });
        } catch (e) {
            console.log(`   ❌ Billing Script Error: ${e.message}`);
        }

        // Re-open DB
        const dbLoop = new Database(SIM_DB);

        // 3. Report & Check Delinquency
        const invoices = dbLoop.prepare("SELECT * FROM invoices").all();
        const pending = invoices.filter(inv => inv.status === 'pending');

        // Check Delinquency Logic
        // Rule: If pending invoice > 28 days old => BLOCK
        // We calculate age relative to SIMULATED NOW (simDate)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        let blockedCount = 0;
        const blockedCompanies = new Set();

        const delinquencyStmt = dbLoop.prepare("UPDATE empresas SET is_blocked = 1, blocked_reason = ? WHERE id = ?");

        pending.forEach(inv => {
            const issueDate = new Date(inv.issue_date); // This depends on what generate_weekly_invoices put there
            const ageMs = simDate.getTime() - issueDate.getTime();
            const ageDays = ageMs / ONE_DAY_MS;

            if (ageDays >= 28) {
                blockedCount++;
                blockedCompanies.add(inv.company_id);
                // Simulate the block
                delinquencyStmt.run(`Simulated Block: Unpaid invoice ${inv.id} (${ageDays.toFixed(1)} days old)`, inv.company_id);
            }
        });

        // Weekly Report
        const weekInvoices = invoices.filter(inv => inv.billing_week === weekLabel);
        console.log(`   💰 Invoices Generated (This Week): ${weekInvoices.length}`);
        if (weekInvoices.length > 0) {
            weekInvoices.forEach(inv => console.log(`      -> Company ${inv.company_id}: $${(inv.total_cents / 100).toFixed(2)}`));
        }

        console.log(`   ⚠️  Total Pending Invoices: ${pending.length} (System Wide)`);

        if (blockedCount > 0) {
            console.log(`   ⛔ DELINQUENCY ENFORCED: ${blockedCount} invoices > 28 days.`);
            console.log(`      BLOCKED COMPANIES: ${Array.from(blockedCompanies).join(', ')}`);
        } else {
            console.log(`   ✅ Delinquency Check: Clean (Max age < 28 days)`);
        }

        dbLoop.close();

        // Prepare for next week (+7 days)
        currentOffset += ONE_WEEK_MINUTES;
    }

} catch (err) {
    console.error("CRITICAL FAILURE:", err);
} finally {
    // ALWAYS restore time
    restoreSimState();
    console.log(`\n=================================================`);
    console.log(`🏁 SIMULATION COMPLETE. Time restored.`);
    console.log(`=================================================`);
}

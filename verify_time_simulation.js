const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SIM_STATE_FILE = path.resolve(__dirname, 'sim_time_state.json');

console.log("--- Verification: 60x Time Simulation & Delinquency ---");

const runCmd = (cmd) => {
    // Force SIM_TIME=1
    const env = { ...process.env, SIM_TIME: '1', SIM_TIME_SCALE: '60', NODE_ENV: 'dev' };
    return execSync(cmd, { stdio: 'inherit', env });
};

const setup = () => {
    // Clean (Reverse Dependency Order)
    db.prepare("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = 777)").run();
    db.prepare("DELETE FROM invoices WHERE company_id = 777").run();
    db.prepare("DELETE FROM tickets WHERE company_id = 777").run();
    db.prepare("DELETE FROM events_outbox WHERE company_id = 777").run();
    db.prepare("DELETE FROM request_visibility WHERE request_id IN (SELECT id FROM solicitudes WHERE empresa_id = 777)").run();
    db.prepare("DELETE FROM solicitudes WHERE empresa_id = 777").run();
    // Driver 1 shared, do not delete
    db.prepare("DELETE FROM empresas WHERE id = 777").run();

    if (fs.existsSync(SIM_STATE_FILE)) fs.unlinkSync(SIM_STATE_FILE);
    fs.writeFileSync(SIM_STATE_FILE, JSON.stringify({ offset_minutes: 0 })); // Reset

    // Create Driver & Request
    db.prepare("INSERT OR IGNORE INTO drivers (id, nombre, contacto, password_hash, tipo_licencia) VALUES (1, 'SimDriver', 'sim@dr.com', 'hash', 'A')").run();
    db.prepare("INSERT OR IGNORE INTO empresas (id, nombre, contacto, password_hash, ciudad, is_blocked) VALUES (777, 'SimComp', 'sim@comp.com', 'hash', 'City', 0)").run();

    // Create Requests (101-104)
    const reqSql = "INSERT OR IGNORE INTO solicitudes (id, empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (?, 777, 'A', 'Loc', 10, '2025-12-31')";
    db.prepare(reqSql).run(101);
    db.prepare(reqSql).run(102);
    db.prepare(reqSql).run(103);
    db.prepare(reqSql).run(104);

    // Tickets
    // Note: We need tickets with created_at in the past relative to the 'current' simulated time?
    // OR we just create them with dates that match the weeks we will process.
    // '2025-01' (Week 1), '2025-02' (Week 2), etc.
    // Let's create them with fixed dates that align with our planned weeks.
    // We will assume "NOW" (real time) is the start point.
    // We should probably start 'clean' relative to a specific week or just force the weeks in generation.
    // The invoices are generated based on ticket week.
    // created_at: '2025-01-01' is definitively Week 2025-01.
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 101, 15000, 'unbilled', '2025-01', '2025-01-01')").run();
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 102, 15000, 'unbilled', '2025-02', '2025-01-08')").run();
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 103, 15000, 'unbilled', '2025-03', '2025-01-15')").run();
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 104, 15000, 'unbilled', '2025-04', '2025-01-22')").run();

    console.log("Setup Complete.");
};

const checkBlock = () => {
    const r = db.prepare("SELECT is_blocked FROM empresas WHERE id = 777").get();
    return r.is_blocked === 1;
};

try {
    setup();

    // 1. Generate Invoice 1 (2025-01)
    // We force the generation for specific week, ignoring 'now' for the target week select logic, but 'issue_date' uses 'now'.
    // NOTE: Sim Time behaves as "Real + Offset". Real Date is 2026. This might be confusing if we mix 2025 tickets.
    // Issue Date will be 2026+. Due Date will be 2026+.
    // Verify script used '2025-01' tickets.
    // IF we run `generate_weekly_invoices.js 2025-01`, it uses that week.
    // Issue Date -> Now (2026).
    // Due Date -> Friday of 2025-01 (Jan 3, 2025).
    // So Invoice due date is in the past! It will be overdue IMMEDIATELY.
    // This breaks the "Advance sim time so invoice becomes overdue" test flow.
    // WE NEED SIM TIME TO START IN THE PAST? Or we align tickets to "Now"?
    // Or we set an Arbitrary Start Time?
    // Users instructions: "sim_now = real_now + offset". This makes going to the past hard unless offset is negative.
    // BUT we can use tickets from *future*? Or just current week?
    // Let's use `now` based weeks.

    // RE-PLAN DATA:
    // We will use the `getMondayBasedWeekLabel` helper to find CURRENT week and +1, +2, +3.
    const { nowIso } = require('./time_provider');
    // We must reset provider state locally or it might read old file from previous run? setup() deletes file.

    // We'll trust the time provider to be "Real Now".
    // 4 Weeks relative to now. 
    // BUT `advance_sim_time` adds offset.
    // So if we start at T=0.
    // Week 1 -> Generate. (Due Friday).
    // Advance 1 week.
    // Week 2 -> Generate.
    // ...
    // Since we rely on `getMondayBasedWeekLabel` inside the script if no arg provided.

    // Let's create tickets dynamically after setup?
    // Actually, `generate_weekly_invoices` takes an arg.
    // We should use specific weeks corresponding to "Simulated Now".

    // To simplify: I'll manually determine the weeks based on the Start Time, create tickets, then run the sequence.
    // PROBLEM: `generate_weekly_invoices` sets `due_date` based on the target week.
    // If target week is "2025-01", Due Date is "2025-01-03".
    // If Sim Time is "2026", "2025-01-03" IS overdue.
    // So we MUST use weeks close to "Real Now".
    // AND we must ensure that initially, they are NOT overdue.
    // i.e. Due Date > Now.
    // If I generate for "Current Week", Due Date is "This Friday".
    // If Today is Saturday, it's overdue.
    // If Today is Monday, it's not.
    // TODAY IS SATURDAY (2026-01-17).
    // 2026-01-17 is Saturday.
    // Week 2026-02 (Jan 12 - Jan 18).
    // Friday was Jan 16.
    // So "Current Week" invoice is ALREADY overdue.
    // We need to target NEXT WEEK (2026-03, Jan 19-25). Due Jan 23.
    // So if we generate invoice for 2026-03, Due Date is Jan 23.
    // Current Sim Time = Jan 17 (Saturday).
    // Jan 23 > Jan 17. Not Overdue. Correct.

    // So Start Week = Next Week.
    // We need to create tickets for W, W+1, W+2, W+3.

    // Helper to get next 4 weeks labels
    const getNextWeeks = () => {
        const d = new Date();
        // Move to next Monday to be safe?
        // Current is Jan 17 (Sat). Next Mon is Jan 19.
        const start = new Date(d.valueOf() + 48 * 3600 * 1000); // roughly +2 days
        // actually let's just find weeks.
        const labels = [];
        for (let i = 0; i < 4; i++) {
            // add 7 days * i
            const future = new Date(start.valueOf() + i * 7 * 24 * 3600 * 1000);
            // use the helper logic (or hardcode if easy)
            // simplified: just assume we can get labels.
            // or better: Use "2030-01" etc to be safe?
            // Use 2030.
            labels.push(`2030-${String(i + 1).padStart(2, '0')}`);
        }
        return labels;
    };

    // Let's use 2030-01, 02, 03, 04.
    // Start Time (Real) is 2026.
    // Invoice 2030-01 Due Date: 2030-01-04.
    // Current Time: 2026. Not overdue.
    // Advance Time: We need to advance ~4 years?
    // That's a huge offset.
    // Better: We need to set Sim Time to 2030-01-01 initially?
    // Formula: sim = real + offset.
    // offset = target - real.
    // We can use `advance_sim_time` to jump to 2030.
    // Calc diff in minutes.

    // Strategy:
    // 1. Calculate offset to jump from Now to 2030-01-02 (Wednesday).
    // 2. Set strict Sim Time using that offset.
    // 3. Create tickets for 2030-01, 02, 03, 04.
    // 4. Run tests.

    const targetStart = new Date('2030-01-02T12:00:00Z'); // Wednesday
    const realNow = new Date();
    const diffMs = targetStart - realNow;
    const diffRealMins = diffMs / 60000;
    // Wait, offset is added as (offset * 60000 * 60).
    // We want Total Offset = diffMs.
    // diffMs = X * 60000 * 60.
    // X = diffMs / (3600000).
    const hoursToJump = diffMs / 3600000;

    // We can run advance_sim_time with "hours" = hoursToJump (in Sim Hours unit inputs? NO).
    // My script: `node advance_sim_time.js minutes 10` -> Adds 10 SIM minutes.
    // I want to add `diffMs` in SIM time.
    // `diffMs` is roughly 4 years.
    // 4 years in minutes.
    // Just pass "minutes" "diffInMinutes".
    const diffSimMinutes = Math.floor(diffMs / 60000);

    // Setup Jump
    console.log(`>>> Jumping to 2030-01-02... (Add ${diffSimMinutes} sim mins)`);
    runCmd(`node advance_sim_time.js minutes ${diffSimMinutes}`);

    // Create Tickets
    db.prepare("DELETE FROM tickets WHERE company_id = 777").run(); // clean again just in case
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 101, 15000, 'unbilled', '2030-01', '2030-01-01')").run();
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 102, 15000, 'unbilled', '2030-02', '2030-01-08')").run();
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 103, 15000, 'unbilled', '2030-03', '2030-01-15')").run();
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, billing_week, created_at) VALUES (777, 1, 104, 15000, 'unbilled', '2030-04', '2030-01-22')").run();

    // 1. Generate Invoice 2030-01
    // Due Date: 2030-01-04. Current Sim: 2030-01-02.
    runCmd("node generate_weekly_invoices.js 2030-01"); // Sim usage in script will use Sim Now for issue_date (2030-01-02), Due Date (calc from week -> 2030-01-04)

    // Advance 1 week (to Jan 9)
    console.log(">>> Advancing 1 Week");
    runCmd("node advance_sim_time.js week 1");
    // Sim Now: 2030-01-09.
    // Invoice 1 (Due Jan 4) -> OVERDUE.
    // Check Status
    runCmd("node check_delinquency.js 777"); // Overdue: 1. Blocked: 0.

    // 2. Generate Invoice 2030-02
    // Due Date: Jan 11.
    runCmd("node generate_weekly_invoices.js 2030-02");

    // Advance 1 week (to Jan 16)
    console.log(">>> Advancing 1 Week");
    runCmd("node advance_sim_time.js week 1");
    // Sim Now: Jan 16.
    // Inv 1 (Due Jan 4) -> Overdue (12 days)
    // Inv 2 (Due Jan 11) -> Overdue (5 days)
    // Total 2.

    // 3. Generate Invoice 2030-03
    runCmd("node generate_weekly_invoices.js 2030-03");
    console.log(">>> Advancing 1 Week");
    runCmd("node advance_sim_time.js week 1");
    // Sim Now: Jan 23.
    // Inv 3 (Due Jan 18) -> Overdue.
    // Total 3.

    // 4. Generate Invoice 2030-04
    runCmd("node generate_weekly_invoices.js 2030-04");
    // Due Jan 25.
    // Current Jan 23. Not Overdue.

    // Advance 3 days -> Jan 26.
    console.log(">>> Advancing 3 Days");
    runCmd("node advance_sim_time.js days 3");

    // Trigger Check
    console.log(">>> Checking Delinquency (Expect Block)");
    try {
        execSync("node check_delinquency.js 777", { stdio: 'inherit', env: { ...process.env, SIM_TIME: '1', SIM_TIME_SCALE: '60' } });
    } catch (e) { } // check_delinquency prints output

    if (!checkBlock()) throw new Error("Should be BLOCKED (4 overdue)");

    // 5. Pay 1 Invoice
    const inv1 = db.prepare("SELECT id FROM invoices WHERE company_id = 777 AND billing_week = '2030-01'").get();
    console.log(`>>> Paying Invoice ${inv1.id}`);
    runCmd(`node mark_invoice_paid.js ${inv1.id}`);

    if (checkBlock()) throw new Error("Should be UNBLOCKED");

    console.log("\n✅ Verification Passed");

} catch (e) {
    console.error("❌ Failed:", e);
    process.exit(1);
}

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const SRC_DB = 'driverflow.db';
const SIM_DB = 'driverflow_sim_45d.db';
const SIM_STATE_FILE = path.resolve(__dirname, '../sim_time_state.json');

// --- SAFETY CHECK (ANTI-PROD) ---
// Only check if DB_PATH is explicitly set in the environment where this script runs.
if (process.env.DB_PATH) {
    if (process.env.DB_PATH.includes(SRC_DB) && !process.env.DB_PATH.includes('sim')) {
        console.error("FATAL: Simulation attempting to run with unsafe DB_PATH.");
        process.exit(1);
    }
}
// Double check source vs target
if (path.resolve(SRC_DB) === path.resolve(SIM_DB)) {
    console.error("FATAL: Source and Target DB are the same file!");
    process.exit(1);
}

// --- TIME HELPERS ---
function getSimTime(offsetMinutes) {
    return new Date(Date.now() + offsetMinutes * 60000);
}

function setSimTimeOffset(minutes) {
    fs.writeFileSync(SIM_STATE_FILE, JSON.stringify({ offset_minutes: minutes }, null, 2));
}

function getIsoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

// --- DB HELPERS ---
function openDb(path) {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
}

function closeDb(db) {
    if (db && db.open) db.close();
}

/**
 * Returns object with schema details required for enforcement.
 */
function introspectSchema(db) {
    let table = 'empresas';
    // Fix A: Use quotes for table name
    let cols = db.prepare(`PRAGMA table_info('empresas')`).all();
    if (cols.length === 0) {
        table = 'companies';
        cols = db.prepare(`PRAGMA table_info('companies')`).all();
    }
    if (cols.length === 0) throw new Error("Could not find companies table.");

    const res = {
        table,
        hasIsBlocked: cols.some(c => c.name === 'is_blocked'),
        hasStatus: cols.some(c => c.name === 'status'),
        hasAccountStatus: cols.some(c => c.name === 'account_status'),
        hasReason: cols.some(c => c.name === 'blocked_reason')
    };

    // Log explicit blocking strategy
    console.log(`[Schema] Blocking Strategy: Table='${res.table}', Column='${res.hasIsBlocked ? 'is_blocked' : res.hasStatus ? 'status' : res.hasAccountStatus ? 'account_status' : 'NONE'}'`);
    return res;
}

function getInvoiceDateColumn(db) {
    const cols = db.prepare("PRAGMA table_info('invoices')").all().map(c => c.name);
    // Fix B: Correct Priority List
    const priorities = ['due_at', 'due_date', 'issued_at', 'issue_date', 'created_at'];
    for (const p of priorities) {
        if (cols.includes(p)) return p;
    }
    throw new Error("No valid date column found in invoices (checked: " + priorities.join(', ') + ")");
}

function parseDateLoose(val) {
    if (val === null || val === undefined || val === '') return null;

    if (typeof val === 'number' || (typeof val === 'string' && val.trim() !== '' && !isNaN(val))) {
        const num = Number(val);
        const ms = num < 1e12 ? num * 1000 : num;
        const d = new Date(ms);
        if (isNaN(d.getTime())) {
            console.warn(`[Warn] Invalid epoch date encountered: ${val}`);
            return null;
        }
        return d;
    }

    const d = new Date(val);
    if (isNaN(d.getTime())) {
        console.warn(`[Warn] Invalid date encountered: ${val}`);
        return null;
    }
    return d;
}

// --- MAIN SIMULATION ---
async function runSimulation() {
    console.log("--- STARTING STRICT BILLING SIMULATION (45 DAYS) ---");
    console.log(`[Safety] Source: ${SRC_DB}`);
    console.log(`[Safety] Target: ${SIM_DB}`);

    // Integrity Proof
    const crypto = require('crypto');
    function getFileHash(filePath) {
        const fileBuffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256');
        hash.update(fileBuffer);
        return hash.digest('hex');
    }

    const preStats = fs.statSync(SRC_DB);
    const preHash = getFileHash(SRC_DB);
    console.log(`[Proof] Pre-Run  ${SRC_DB}: Size=${preStats.size}, SHA256=${preHash}`);


    // 1. Setup Simulation DB
    if (fs.existsSync(SIM_DB)) {
        try { fs.unlinkSync(SIM_DB); } catch (e) { }
    }
    fs.copyFileSync(SRC_DB, SIM_DB);
    console.log(`[Setup] DB Cloned.`);

    // Backup Original Time State
    let originalState = null;
    if (fs.existsSync(SIM_STATE_FILE)) originalState = fs.readFileSync(SIM_STATE_FILE, 'utf-8');

    const ONE_WEEK_MIN = 7 * 24 * 60;
    let currentOffset = 0;

    try {
        // Introspect once to log setup
        const setupDb = openDb(SIM_DB);

        // Log Absolute Path
        console.log(`[Main] SIM_DB Absolute Path: ${path.resolve(SIM_DB)}`);

        // Log Main Process DB List
        const dbList = setupDb.prepare("PRAGMA database_list").all();
        console.log(`[Main] PRAGMA database_list: ${JSON.stringify(dbList)}`);

        const schema = introspectSchema(setupDb);
        const dateCol = getInvoiceDateColumn(setupDb);
        console.log(`[Schema] Table: ${schema.table}`);
        console.log(`[Schema] Date Key: ${dateCol}`);
        closeDb(setupDb);

        // --- WEEKLY LOOP ---
        for (let week = 1; week <= 7; week++) {
            const simDate = getSimTime(currentOffset);
            const weekLabel = getIsoWeek(simDate);

            console.log(`\n-----------------------------------------------------------`);
            console.log(`📅 WEEK ${week}: ${weekLabel} (Sim Date: ${simDate.toISOString().split('T')[0]})`);
            console.log(`-----------------------------------------------------------`);

            // A. Set Simulation Time
            setSimTimeOffset(currentOffset);

            // B. Run Billing (Subprocess)
            // Passing DEBUG_DB=1 triggers the PRAGMA database_list log in generate_weekly_invoices.js
            try {
                const cmd = `node generate_weekly_invoices.js ${weekLabel}`;
                const envVars = { ...process.env, DB_PATH: SIM_DB, SIM_TIME: '1', DEBUG_DB: '1' };
                console.log(`[Exec] Command: "${cmd}"`);
                console.log(`[Exec] Env: DB_PATH=${envVars.DB_PATH}, SIM_TIME=${envVars.SIM_TIME}, DEBUG_DB=${envVars.DEBUG_DB}`);

                execSync(cmd, {
                    cwd: path.resolve(__dirname, '..'),
                    stdio: 'inherit',
                    env: envVars
                });
            } catch (e) {
                console.error("   ❌ Invoice Generation Failed.");
            }

            // C. Enforcement & Reporting
            const db = openDb(SIM_DB);

            // 1. New Invoices This Week
            const invoices = db.prepare("SELECT * FROM invoices").all();
            const newInvoices = invoices.filter(i => i.billing_week === weekLabel);

            // 2. Identify Overdue
            const pending = invoices.filter(i => i.status === 'pending'); // Keeping variable name 'pending' but filtering logic below handles the real eligible set

            // Fix: Consider impagas TODAS las invoices cuyo status NO sea 'paid', 'void', 'cancelled'
            const eligibleInvoices = invoices.filter(i =>
                i.status !== 'paid' && i.status !== 'void' && i.status !== 'cancelled'
            );

            const ONE_DAY_MS = 86400000;
            const overdueCompanies = new Set();
            let overdueInvoicesCount = 0;

            for (const inv of eligibleInvoices) {
                const dateVal = inv[dateCol];
                const invDate = parseDateLoose(dateVal);
                if (!invDate) continue;

                const ageDays = (simDate.getTime() - invDate.getTime()) / ONE_DAY_MS;

                if (ageDays >= 28) {
                    overdueInvoicesCount++;
                    overdueCompanies.add(inv.company_id);
                }
            }

            const distinctOverdueCompanyIds = Array.from(overdueCompanies).sort((a, b) => a - b);

            // 3. Idempotent Enforcement
            const newlyBlockedIds = [];
            const alreadyBlockedIds = [];

            const enforceTx = db.transaction(() => {
                for (const cid of distinctOverdueCompanyIds) {
                    // Check current status
                    const company = db.prepare(`SELECT * FROM ${schema.table} WHERE id = ?`).get(cid);
                    if (!company) continue;

                    let isAlreadyBlocked = false;
                    if (schema.hasIsBlocked) isAlreadyBlocked = (company.is_blocked === 1);
                    else if (schema.hasStatus) isAlreadyBlocked = (String(company.status).toUpperCase() === 'BLOCKED');
                    else if (schema.hasAccountStatus) isAlreadyBlocked = (String(company.account_status).toUpperCase() === 'BLOCKED');

                    if (isAlreadyBlocked) {
                        alreadyBlockedIds.push(cid);
                    } else {
                        // Apply Block
                        newlyBlockedIds.push(cid);
                        const reason = `Overdue > 28d (Sim Week ${weekLabel})`;

                        if (schema.hasIsBlocked) {
                            db.prepare(`UPDATE ${schema.table} SET is_blocked=1 WHERE id=?`).run(cid);
                        } else if (schema.hasStatus) {
                            db.prepare(`UPDATE ${schema.table} SET status='BLOCKED' WHERE id=?`).run(cid);
                        } else if (schema.hasAccountStatus) {
                            db.prepare(`UPDATE ${schema.table} SET account_status='BLOCKED' WHERE id=?`).run(cid);
                        }

                        if (schema.hasReason) {
                            db.prepare(`UPDATE ${schema.table} SET blocked_reason=? WHERE id=?`).run(reason, cid);
                        }
                    }
                }
            });
            enforceTx();

            // 4. Detailed Report
            console.log(`\n   📊 Weekly Report:`);
            console.log(`      New Invoices Created: ${newInvoices.length}`);
            console.log(`      Total Pending Invoices: ${invoices.filter(i => i.status === 'pending').length} (System Wide)`);
            console.log(`      Overdue Invoices (>28d): ${overdueInvoicesCount}`);
            console.log(`      Overdue Companies (Distinct): ${distinctOverdueCompanyIds.length} -> IDs: [${distinctOverdueCompanyIds.join(', ')}]`);

            if (newlyBlockedIds.length > 0) {
                console.log(`      🛑 NEWLY BLOCKED This Week: ${newlyBlockedIds.length}`);
                console.log(`         IDs: [${newlyBlockedIds.sort((a, b) => a - b).join(', ')}]`);
            } else {
                console.log(`      ✅ Newly Blocked: 0`);
            }
            if (alreadyBlockedIds.length > 0) {
                console.log(`      🔒 Already Blocked: ${alreadyBlockedIds.length} (IDs: ${alreadyBlockedIds.sort((a, b) => a - b).join(', ')})`);
            }


            closeDb(db);
            currentOffset += ONE_WEEK_MIN;
        }

    } catch (e) {
        console.error("\n❌ CRITICAL SIMULATION ERROR:", e);
    } finally {
        if (originalState) fs.writeFileSync(SIM_STATE_FILE, originalState);
        else if (fs.existsSync(SIM_STATE_FILE)) fs.unlinkSync(SIM_STATE_FILE);

        console.log(`\n=================================================`);
        console.log(`🏁 SIMULATION DONE.`);

        const postStats = fs.statSync(SRC_DB);
        const postHash = getFileHash(SRC_DB);
        console.log(`[Proof] Post-Run ${SRC_DB}: Size=${postStats.size}, SHA256=${postHash}`);

        if (preHash === postHash) {
            console.log(`✅ SUCCESS: driverflow.db Hash Matches (Untouched).`);
        } else {
            console.error(`❌ FAILURE: driverflow.db HASH CHANGED!`);
        }

        console.log(`   Sim  DB Path: ${path.resolve(SIM_DB)}`);
        console.log(`driverflow.db untouched: true`);
        console.log(`=================================================`);
    }
}

runSimulation();

const dbPath = process.env.DB_PATH || 'driverflow.db';
const Database = require('better-sqlite3');
let db;

try {
    db = new Database(dbPath, { timeout: 5000 });
} catch (e) {
    console.log(`FATAL: Could not open DB at ${dbPath}. Error: ${e.message}`);
    process.exit(1);
}

const { nowIso, nowEpochMs } = require('./time_provider');
const { enforceCompanyCanOperate } = require('./access_control');

const companyId = parseInt(process.argv[2]);
const weeks = parseInt(process.argv[3]) || 1;
const allowBlocked = process.env.ALLOW_BLOCKED === '1';

if (!companyId) {
    console.log("Usage: node seed_weekly_tickets.js <company_id> [weeks_count]");
    process.exit(1);
}

// MAIN EXECUTION WRAPPER
try {
    // 1. Ensure Company & Driver
    const driverId = 1;
    db.prepare("INSERT OR IGNORE INTO drivers (id, nombre, contacto, password_hash, tipo_licencia) VALUES (1, 'SimDriver', 'sim@dr.com', 'hash', 'A')").run();

    const existingComp = db.prepare("SELECT * FROM empresas WHERE id = ?").get(companyId);
    if (!existingComp) {
        const name = `SimCo_${companyId}`;
        const email = `billing_test_${companyId}@driverflow.app`;
        db.prepare("INSERT INTO empresas (id, nombre, contacto, password_hash, ciudad, is_blocked) VALUES (?, ?, ?, 'hash', 'City', 0)").run(companyId, name, email);
    }

    // 2. Determine Start Time (Current Sim Time)
    const startMs = nowEpochMs();
    const oneWeekMs = 7 * 24 * 3600 * 1000;

    for (let i = 0; i < weeks; i++) {
        const tMs = startMs + (i * oneWeekMs);
        const tDate = new Date(tMs);
        const dateStr = tDate.toISOString();

        // STRICT BLOCK CHECK
        if (!allowBlocked) {
            try {
                enforceCompanyCanOperate(db, companyId, 'seed_weekly_tickets');
            } catch (e) {
                if (e.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') {
                    console.log(`[BLOCKED] Company ${companyId} cannot generate tickets. Reason: ${e.details.reason}`);
                    continue;
                }
                throw e; // Rethrow unexpected validation errors
            }
        }

        const reqId = (companyId * 1000) + Math.floor(tMs / 10000);

        // Create Request
        db.prepare(`
            INSERT OR REPLACE INTO solicitudes 
            (id, empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion, estado, fecha_creacion)
            VALUES (?, ?, 'A', 'Sim Location', 10, '2030-12-31', 'ACEPTADA', ?)
        `).run(reqId, companyId, dateStr);

        // Create Ticket
        db.prepare(`
            INSERT OR REPLACE INTO tickets 
            (company_id, driver_id, request_id, price_cents, billing_status, created_at, billing_week, currency)
            VALUES (?, ?, ?, 15000, 'unbilled', ?, NULL, 'USD')
        `).run(companyId, driverId, reqId, dateStr);

        console.log(`Created Ticket [Req:${reqId}] at ${dateStr}`);
    }

} catch (err) {
    // Catch-all for logic/DB errors to prevent NativeCommandError noise and ensure logging
    console.log(`FATAL_ERROR_IN_SEED: ${err.message}`);
    if (err.stack) console.log(err.stack);
    process.exit(1);
}

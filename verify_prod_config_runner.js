const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

console.log('--- VERIFICATION: Production Config (A) ---\n');

// 1. SETUP TEST ENVIRONMENT (Clean DB)
const DB_PATH = 'driverflow_verify_TEST.db';
if (fs.existsSync(DB_PATH)) {
    try {
        fs.unlinkSync(DB_PATH);
    } catch (e) {
        console.error('Error cleaning DB_PATH. Ensure no other process is using it.');
    }
}

// 2. MIGRATE (Self-Contained Schema)
console.log('[SETUP] Creating Self-Contained Test Schema...');
const db = new Database(DB_PATH);

// Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        contacto TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        ciudad TEXT,
        estado TEXT DEFAULT 'ACTIVO',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        search_status TEXT DEFAULT 'ON' CHECK(search_status IN ('ON', 'OFF')),
        is_blocked INTEGER DEFAULT 0,
        blocked_reason TEXT,
        blocked_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        contacto TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        tipo_licencia TEXT CHECK(tipo_licencia IN ('A','B','C')),
        estado TEXT DEFAULT 'DISPONIBLE' CHECK(estado IN ('DISPONIBLE','OCUPADO','SUSPENDED')),
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
        rating_avg REAL DEFAULT 0,
        suspension_reason TEXT,
        search_status TEXT DEFAULT 'ON' CHECK(search_status IN ('ON', 'OFF'))
    );
    CREATE TABLE IF NOT EXISTS solicitudes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL,
        driver_id INTEGER,
        licencia_req TEXT NOT NULL,
        ubicacion TEXT NOT NULL,
        tiempo_estimado INTEGER NOT NULL,
        estado TEXT DEFAULT 'PENDIENTE' CHECK(estado IN ('PENDIENTE','EN_REVISION','ACEPTADA','FINALIZADA','CANCELADA','EXPIRADA')),
        fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
        fecha_expiracion DATETIME,
        fecha_cierre DATETIME,
        cancelado_por TEXT,
        ronda_actual INTEGER DEFAULT 1,
        fecha_inicio_ronda DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(empresa_id) REFERENCES empresas(id),
        FOREIGN KEY(driver_id) REFERENCES drivers(id)
    );
    CREATE TABLE IF NOT EXISTS request_visibility (
        request_id INTEGER,
        driver_id INTEGER,
        ronda INTEGER,
        PRIMARY KEY (request_id, driver_id)
    );
    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        driver_id INTEGER NOT NULL,
        request_id INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        currency TEXT DEFAULT 'USD',
        billing_status TEXT DEFAULT 'unbilled' CHECK(billing_status IN ('unbilled','billed','void')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        FOREIGN KEY(company_id) REFERENCES empresas(id),
        FOREIGN KEY(driver_id) REFERENCES drivers(id),
        FOREIGN KEY(request_id) REFERENCES solicitudes(id)
    );
    CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        total_cents INTEGER NOT NULL,
        currency TEXT DEFAULT 'USD',
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','void','overdue')),
        issue_date DATETIME NOT NULL,
        due_date DATETIME NOT NULL,
        billing_week TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME,
        paid_method TEXT,
        FOREIGN KEY(company_id) REFERENCES empresas(id)
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        ticket_id INTEGER NOT NULL,
        price_cents INTEGER NOT NULL,
        FOREIGN KEY(invoice_id) REFERENCES invoices(id),
        FOREIGN KEY(ticket_id) REFERENCES tickets(id)
    );
    CREATE TABLE IF NOT EXISTS events_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        created_at DATETIMEDEFAULT CURRENT_TIMESTAMP,
        company_id INTEGER,
        driver_id INTEGER,
        request_id INTEGER,
        ticket_id INTEGER,
        metadata TEXT,
        process_status TEXT DEFAULT 'pending' CHECK(process_status IN ('pending','sent','failed')),
        processed_at DATETIME,
        last_error TEXT,
        send_attempts INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        provider TEXT,
        received_at DATETIME DEFAULT (datetime('now')),
        CONSTRAINT unique_event_id UNIQUE (id)
    );
    CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER UNIQUE,
        company_id INTEGER,
        driver_id INTEGER,
        rating INTEGER CHECK(rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

console.log('[SETUP] Schema Created.');

// 3. SEED DATA
const now = new Date();
const nowIso = now.toISOString();
const past30d = new Date(now.getTime() - 30 * 86400000).toISOString();

const runSql = (sql, args) => db.prepare(sql).run(args);

// A. Blocked Company
const debtPass = '$2a$10$X7H...';
const idDebt = runSql("INSERT INTO empresas (nombre, contacto, password_hash, ciudad, search_status, is_blocked) VALUES (?, ?, ?, ?, ?, 0)", ['CoDebt', 'debt@co.com', debtPass, 'City', 'ON']).lastInsertRowid;
runSql("INSERT INTO invoices (company_id, total_cents, status, issue_date, due_date, billing_week) VALUES (?, 5000, 'pending', ?, ?, '2026-W01')", [idDebt, past30d, past30d]);

// B. Safe Company
const idSafe = runSql("INSERT INTO empresas (nombre, contacto, password_hash, ciudad, search_status, is_blocked) VALUES (?, ?, ?, ?, ?, 0)", ['CoSafe', 'safe@co.com', debtPass, 'City', 'ON']).lastInsertRowid;

// Driver
const idDriver = runSql("INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia, estado, search_status) VALUES (?, ?, ?, ?, ?, ?)", ['Driver1', 'd1@test.com', debtPass, 'A', 'DISPONIBLE', 'ON']).lastInsertRowid;

// C. Scenario Data for Safe Company
// 1. Pending
const r1 = runSql("INSERT INTO solicitudes (empresa_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_expiracion) VALUES (?, 'A', 'Loc1', 60, 'PENDIENTE', ?)", [idSafe, nowIso]).lastInsertRowid;

// 2. Unpaid
const r2 = runSql("INSERT INTO solicitudes (empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_expiracion) VALUES (?, ?, 'A', 'Loc2', 60, 'ACEPTADA', ?)", [idSafe, idDriver, nowIso]).lastInsertRowid;
const t2 = runSql("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, created_at) VALUES (?, ?, ?, 1000, 'billed', ?)", [idSafe, idDriver, r2, nowIso]).lastInsertRowid;
const inv2 = runSql("INSERT INTO invoices (company_id, total_cents, status, issue_date, due_date, billing_week, currency) VALUES (?, 1000, 'pending', ?, ?, '2026-W03', 'USD')", [idSafe, nowIso, nowIso]).lastInsertRowid;
runSql("INSERT INTO invoice_items (invoice_id, ticket_id, price_cents) VALUES (?, ?, 1000)", [inv2, t2]);

// 3. Paid
const r3 = runSql("INSERT INTO solicitudes (empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_expiracion) VALUES (?, ?, 'A', 'Loc3', 60, 'ACEPTADA', ?)", [idSafe, idDriver, nowIso]).lastInsertRowid;
const t3 = runSql("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, created_at) VALUES (?, ?, ?, 1000, 'billed', ?)", [idSafe, idDriver, r3, nowIso]).lastInsertRowid;
const inv3 = runSql("INSERT INTO invoices (company_id, total_cents, status, issue_date, due_date, billing_week, currency, paid_at) VALUES (?, 1000, 'paid', ?, ?, '2026-W03', 'USD', ?)", [idSafe, nowIso, nowIso, nowIso]).lastInsertRowid;
runSql("INSERT INTO invoice_items (invoice_id, ticket_id, price_cents) VALUES (?, ?, 1000)", [inv3, t3]);

// 4. Void
const r4 = runSql("INSERT INTO solicitudes (empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_expiracion) VALUES (?, ?, 'A', 'Loc4', 60, 'CANCELADA', ?)", [idSafe, idDriver, nowIso]).lastInsertRowid;
const t4 = runSql("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, created_at) VALUES (?, ?, ?, 1000, 'void', ?)", [idSafe, idDriver, r4, nowIso]).lastInsertRowid;

db.close();

// SERVER
const SERVER_ENV = {
    ...process.env,
    DB_PATH,
    PORT: '3335',
    WEBHOOK_SECRET: 'verify_secret',
    JWT_SECRET: 'test_key',
    NODE_ENV: 'test',
    DRY_RUN: '1',
    EMAIL_FROM_BILLING: 'test@driverflow.app'
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const request = (method, path, body, headers = {}) => {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1', port: 3335,
            path, method, headers: { 'Content-Type': 'application/json', ...headers }
        }, (res) => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', (e) => resolve({ status: 500, body: e.message }));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
};

(async () => {
    const server = spawn('node', ['server.js'], { env: SERVER_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => process.stderr.write(`[SRV_ERR] ${d}`));
    await wait(2000);

    const jwt = require('jsonwebtoken');
    const tokenDebt = jwt.sign({ id: idDebt, type: 'empresa' }, 'test_key');
    const tokenSafe = jwt.sign({ id: idSafe, type: 'empresa' }, 'test_key');

    // 1. Blocking
    const resBlock = await request('POST', '/create_request', { licencia_req: 'A', ubicacion: 'Test', tiempo_estimado: 60 }, { Authorization: `Bearer ${tokenDebt}` });
    console.log(`\nCreate Request (Debt): ${resBlock.status} (Exp: 403)`);
    // DB Check
    const dbC = new Database(DB_PATH, { readonly: true });
    const bCheck = dbC.prepare("SELECT is_blocked FROM empresas WHERE id = ?").get(idDebt);
    console.log(`DB IsBlocked: ${bCheck.is_blocked} (Exp: 1)`);

    // 2. Contact Reveal
    console.log('\n--- 2. CONTACT REVEAL TEST ---');
    const chk = async (rid, exp, tag) => {
        const r = await request('GET', `/request/${rid}/contact`, {}, { Authorization: `Bearer ${tokenSafe}` });
        // NOTE: Log body to debug 500
        console.log(`[${tag}] Req ${rid}: ${r.status} (Exp: ${exp}) Body: ${JSON.stringify(r.body)}`);
    };
    await chk(r1, 403, 'Pending');
    await chk(r2, 402, 'Unpaid');
    await chk(r3, 200, 'Paid');
    await chk(r4, 403, 'Void');

    // 3. Webhook (Quick)
    await request('POST', '/webhooks/payment', { id: 'ok', type: 'invoice.paid', data: { invoice_id: inv2, amount_paid_cents: 1000 } }, { 'x-webhook-secret': 'verify_secret' });

    server.kill();
    process.exit(0);
})();

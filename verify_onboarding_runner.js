const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

console.log('--- REAL VERIFICATION: Company Onboarding ---');

// 1. SETUP TEST ENV (Clean DB)
const DB_PATH = 'driverflow_verify_onboard.db';
if (fs.existsSync(DB_PATH)) {
    try { fs.unlinkSync(DB_PATH); } catch (e) { }
}

// 2. MIGRATE (Using REAL migrate_all.js)
console.log('[SETUP] Running Real Migrations...');
try {
    execSync('node migrate_all.js', {
        env: { ...process.env, DB_PATH },
        stdio: 'inherit'
    });
} catch (e) {
    console.error('Migration failed');
    process.exit(1);
}

// SERVER ENV
const SERVER_ENV = {
    ...process.env,
    DB_PATH,
    PORT: '3336',
    JWT_SECRET: 'test_key',
    NODE_ENV: 'test',
    DRY_RUN: '1'
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const request = (method, path, body, headers = {}) => {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1', port: 3336,
            path, method, headers: { 'Content-Type': 'application/json', ...headers }
        }, (res) => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
        });
        req.on('error', (e) => resolve({ status: 500, body: e.message }));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
};

(async () => {
    // 3. START SERVER (Inherit stdio to see 500 errors)
    const server = spawn('node', ['server.js'], { env: SERVER_ENV, stdio: 'inherit' });

    await wait(3000); // Give it time to boot

    try {
        // 1. REGISTER (Success)
        console.log('\n--- 1. REGISTRATION TEST ---');
        const pl = {
            type: 'empresa',
            nombre: 'RealVerify Co',
            contacto: 'admin@realverify.com',
            password: 'pass',
            legal_name: 'Real Verify LLC',
            address_line1: '999 Tech Blvd',
            address_city: 'Silicon Valley',
            address_state: 'CA',
            contact_person: 'Jane QA',
            contact_phone: '555-9999',
            match_prefs: { req_license: 'B', req_experience: '3yr+' }
        };
        const reg = await request('POST', '/register', pl);
        // LOG FULL BODY ON ERROR
        console.log(`Register: ${reg.status} (Exp: 201) Body: ${JSON.stringify(reg.body)}`);

        if (reg.status !== 201) throw new Error('Registration failed');
        const companyId = reg.body.id;

        // DB Verification
        const dbC = new Database(DB_PATH, { readonly: true });
        const co = dbC.prepare("SELECT * FROM empresas WHERE id=?").get(companyId);
        const prefs = dbC.prepare("SELECT * FROM company_match_prefs WHERE company_id=?").get(companyId);

        console.log(`DB Check: Status='${co.search_status}' (Exp: 'OFF')`);
        console.log(`DB Check: PrefsLicense='${prefs ? prefs.req_license : 'MISSING'}' (Exp: 'B')`);

        if (co.search_status !== 'OFF') console.error('FAIL: search_status should be OFF');
        if (!prefs || prefs.req_license !== 'B') console.error('FAIL: match_prefs missing or wrong');

        dbC.close();

        // 2. ACTIVATION (Toggle Search)
        console.log('\n--- 2. ACTIVATION TEST ---');
        // Auth Token
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: companyId, type: 'empresa' }, 'test_key');

        // Switch ON
        const onRes = await request('POST', '/company/search_status', { status: 'ON' }, { Authorization: `Bearer ${token}` });
        console.log(`Switch ON: ${onRes.status} (Exp: 200) Status: ${onRes.body.search_status}`);

        if (onRes.status !== 200 || onRes.body.search_status !== 'ON') console.error('FAIL: Failed to switch ON');

        // 3. GUARD (Block & Try to Switch)
        console.log('\n--- 3. BLOCKING GUARD TEST ---');
        const dbW = new Database(DB_PATH);

        // First, ensure it's OFF so we can try to turn it ON (Logic only blocks ON)
        dbW.prepare("UPDATE empresas SET search_status='OFF' WHERE id=?").run(companyId);

        // Block it Manually
        dbW.prepare("UPDATE empresas SET is_blocked=1, blocked_reason='Manual Violation' WHERE id=?").run(companyId);

        // Try to switch ON (Should Fail)
        const blockRes = await request('POST', '/company/search_status', { status: 'ON' }, { Authorization: `Bearer ${token}` });
        console.log(`Switch ON (Blocked): ${blockRes.status} (Exp: 403) Err: ${blockRes.body.error}`);

        if (blockRes.status !== 403) console.error('FAIL: Should have blocked switch ON');

        dbW.close();

        // 4. NOTIFICATIONS
        console.log('\n--- 4. CHECK OUTBOX & PROCESS ---');
        // Run processor
        try {
            execSync('node process_outbox_emails.js', { env: SERVER_ENV });
        } catch (e) {
            console.log('Email processor run finished (or error/empty): ' + e.message);
        }

        const dbFinal = new Database(DB_PATH, { readonly: true });
        const evts = dbFinal.prepare("SELECT event_name, process_status FROM events_outbox WHERE company_id=? ORDER BY id ASC").all(companyId);
        console.table(evts);

        const hasReg = evts.find(e => e.event_name === 'company_registered');
        const hasStatus = evts.find(e => e.event_name === 'search_status_changed');

        if (!hasReg) console.error('FAIL: Missing company_registered event');
        if (!hasStatus) console.error('FAIL: Missing search_status_changed event');

        dbFinal.close();

    } catch (e) {
        console.error('TEST ERROR:', e);
    } finally {
        server.kill();
        process.exit(0);
    }
})();

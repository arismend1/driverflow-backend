const { spawn, execSync } = require('child_process');
const fs = require('fs');

const DB_PATH = 'security_adv.db';
const PORT = '3005';
const API_URL = `http://localhost:${PORT}`;

// Setup Clean DB
try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch (e) { }

const env = {
    ...process.env,
    DB_PATH,
    PORT,
    NODE_ENV: 'test', // Avoid production strict checks
    JWT_SECRET: 'test_secret',
    FROM_EMAIL: 'no-reply@driverflow.app',
    SENDGRID_API_KEY: 'SG.FAKE_KEY_LONG_ENOUGH_TEST_XXXX',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    RATE_LIMIT_MAX: '20'
};

// Init DB
console.log('--- Init DB ---');
try {
    execSync('node migrate_phase1.js', { env, stdio: 'inherit' });
    execSync('node migrate_phase2.js', { env, stdio: 'inherit' });
    execSync('node migrate_phase3.js', { env, stdio: 'inherit' });
    // IMPORTANT: Run the auth fix migration to add new columns
    execSync('node migrate_auth_fix.js', { env, stdio: 'inherit' });
} catch (e) {
    console.error('Migration Failed:', e.message);
    process.exit(1);
}

// Start Server
console.log('--- Starting Server ---');
const server = spawn('node', ['server.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function safeFetch(url, options) {
    try {
        const res = await fetch(url, options);
        const text = await res.text();
        try {
            return { status: res.status, ok: res.ok, json: JSON.parse(text) };
        } catch {
            return { status: res.status, ok: res.ok, text };
        }
    } catch (e) {
        return { error: e.message };
    }
}

async function runTests() {
    await wait(5000);

    console.log('--- TEST 0: Health Check ---');
    const health = await safeFetch(`${API_URL}/health`);
    if (health.error) {
        console.log(`❌ Server Crash/Unreachable: ${health.error}`);
        server.kill();
        process.exit(1);
    }
    console.log('✅ Server Up');

    console.log('--- TEST 1: Bad Email Regex ---');
    let res = await safeFetch(`${API_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', nombre: 'Test', contacto: 'bad-email', password: 'StrongPassword1', confirm_password: 'StrongPassword1' })
    });
    console.log(res.status === 400 && res.json.error === 'INVALID_EMAIL_FORMAT' ? '✅ Pass' : `❌ Fail: ${JSON.stringify(res)}`);

    console.log('--- TEST 2: Register Success ---');
    const email = 'lockout@test.com';
    res = await safeFetch(`${API_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', nombre: 'Test Lockout', contacto: email, password: 'StrongPassword1', confirm_password: 'StrongPassword1' })
    });
    // Manually verify by setting verified=1 in DB so we can login
    if (res.ok) {
        const db = require('better-sqlite3')(DB_PATH);
        db.prepare("UPDATE drivers SET verified=1 WHERE contacto=?").run(email);
        db.close();
        console.log('✅ Pass');
    } else {
        console.log(`❌ Fail: ${JSON.stringify(res)}`);
    }

    console.log('--- TEST 3: Lockout (5 failures) ---');
    for (let i = 0; i < 5; i++) {
        await safeFetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'driver', contacto: email, password: 'WrongPassword' })
        });
    }
    // 6th attempt
    res = await safeFetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', contacto: email, password: 'WrongPassword' })
    });
    console.log(res.status === 403 && res.json.error === 'ACCOUNT_LOCKED' ? '✅ Pass' : `❌ Fail: ${JSON.stringify(res)}`);

    console.log('--- TEST 4: Delete Account ---');
    // Login with another user
    const email2 = 'delete@test.com';
    await safeFetch(`${API_URL}/register`, {
        method: 'POST',
        body: JSON.stringify({ type: 'driver', nombre: 'Delete Me', contacto: email2, password: 'StrongPassword1', confirm_password: 'StrongPassword1' }),
        headers: { 'Content-Type': 'application/json' }
    });
    // Manually verify
    {
        const db = require('better-sqlite3')(DB_PATH);
        db.prepare("UPDATE drivers SET verified=1 WHERE contacto=?").run(email2);
        db.close();
    }

    // Login
    let login = await safeFetch(`${API_URL}/login`, {
        method: 'POST',
        body: JSON.stringify({ type: 'driver', contacto: email2, password: 'StrongPassword1' }),
        headers: { 'Content-Type': 'application/json' }
    });

    if (login.ok && login.json.token) {
        // Delete
        res = await safeFetch(`${API_URL}/delete_account`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${login.json.token}` },
            body: JSON.stringify({ password: 'StrongPassword1' })
        });
        console.log(res.ok && res.json.success ? '✅ Pass' : `❌ Fail: ${JSON.stringify(res)}`);
    } else {
        console.log('❌ Login Failed for Delete Test');
    }

    server.kill();
    process.exit(0);
}

runTests();

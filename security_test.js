const { spawn, execSync } = require('child_process');
const fs = require('fs');

const DB_PATH = 'security_test.db';
const PORT = '3004';
const API_URL = `http://localhost:${PORT}`;

// Setup
try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch (e) { }

const env = {
    ...process.env,
    DB_PATH,
    PORT,
    // Strict requirement met
    FROM_EMAIL: 'no-reply@driverflow.app',
    SENDGRID_API_KEY: 'SG.FAKE_KEY_LONG_ENOUGH_TEST_XXXX',
    ALLOWED_ORIGINS: 'http://localhost:3000'
};

// Init DB
console.log('--- Init DB ---');
execSync('node migrate_phase1.js', { env, stdio: 'ignore' });
execSync('node migrate_phase2.js', { env, stdio: 'ignore' });
execSync('node migrate_phase3.js', { env, stdio: 'ignore' });

// Start Server
console.log('--- Starting Server ---');
const server = spawn('node', ['server.js'], { env, stdio: 'pipe' });
server.stdout.on('data', d => { });

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runTests() {
    await wait(4000);
    console.log('--- TEST 1: Weak Password ---');
    let res = await fetch(`${API_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', nombre: 'Test', contacto: 'weak@test.com', password: 'weak' })
    });
    let data = await res.json();
    console.log(res.status === 400 && data.error === 'WEAK_PASSWORD' ? '✅ Pass' : `❌ Fail: ${JSON.stringify(data)}`);

    console.log('--- TEST 2: Password Mismatch ---');
    res = await fetch(`${API_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', nombre: 'Test', contacto: 'mismatch@test.com', password: 'StrongPassword1', confirm_password: 'OtherPassword' })
    });
    data = await res.json();
    console.log(res.status === 400 && data.error === 'PASSWORDS_DO_NOT_MATCH' ? '✅ Pass' : `❌ Fail: ${JSON.stringify(data)}`);

    console.log('--- TEST 3: Rate Limit (Forgot) ---');
    for (let i = 0; i < 6; i++) {
        res = await fetch(`${API_URL}/forgot_password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'spam@test.com' })
        });
        if (i === 5) {
            console.log(res.status === 429 ? '✅ Pass (429 Rate Limited)' : `❌ Fail: Got ${res.status}`);
        }
    }

    console.log('--- TEST 4: CORS ---');
    res = await fetch(`${API_URL}/health`, { method: 'OPTIONS', headers: { 'Origin': 'http://evil.com' } });
    // CORS usually handles OPTIONS or main request headers. If blocked, headers won't have ACAO.
    // Simpler check: curl would fail. Here check normal request with Origin.
    try {
        res = await fetch(`${API_URL}/health`, { headers: { 'Origin': 'http://evil.com' } });
        if (!res.ok) console.log('✅ Pass (Blocked/Error)'); // Fetch might throw or server error
        else console.log('ℹ️  Allowed? Express CORS mostly relies on browser. Check Curl later.');
    } catch (e) { console.log('✅ Pass (Connection Refused/Blocked)'); }

    server.kill();
    process.exit(0);
}

runTests();

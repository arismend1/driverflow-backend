const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');

const DB_PATH = 'repro.db';

console.log('--- STARTING REPRO TEST ---');

// 0. Clean Setup
try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    console.log('✅ Cleaned old DB');
} catch (e) { console.error('Warning cleaning DB:', e); }

// 1. Initialize DB (Phases 1-3)
const env = { ...process.env, DB_PATH, PORT: '3001', SENDGRID_API_KEY: 'SG.FAKE_KEY_LONG_ENOUGH_FOR_TEST', FROM_EMAIL: 'no-reply@driverflow.app' };

try {
    console.log('--- Running Base Migrations ---');
    execSync('node migrate_phase1.js', { env, stdio: 'inherit' });
    execSync('node migrate_phase2.js', { env, stdio: 'inherit' });
    execSync('node migrate_phase3.js', { env, stdio: 'inherit' });
    console.log('✅ Base Schema Created');
} catch (e) {
    console.error('❌ Migration Failed:', e.message);
    process.exit(1);
}

// 2. Start Server
console.log('--- Starting Server (triggers migrate_auth_fix.js) ---');
const server = spawn('node', ['server.js'], { env, stdio: 'pipe' });

server.stdout.on('data', d => console.log(`[SERVER]: ${d.toString().trim()}`));
server.stderr.on('data', d => console.error(`[SERVER_ERR]: ${d.toString().trim()}`));

server.on('close', (code) => {
    console.log(`[SERVER] Exited with code ${code}`);
    if (code !== 0 && code !== null) process.exit(code);
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runTests() {
    console.log('Waiting 10s for server startup...');
    await wait(10000);

    const baseUrl = 'http://localhost:3001';

    let token = '';

    // A) Health
    const health = await fetch(baseUrl + '/health');
    console.log('Health:', health.status, await health.json());

    // B) Register Driver
    const email = 'testuser' + Date.now() + '@example.com';
    const regRes = await fetch(baseUrl + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'driver',
            nombre: 'Juan Test',
            contacto: email,
            password: 'password123',
            tipo_licencia: 'A'
        })
    });
    const regData = await regRes.json();
    console.log('Register:', regRes.status, regData);
    if (!regData.require_email_verification) console.error('❌ Expected verify required');

    // C) Login (Should Fail)
    const loginFail = await fetch(baseUrl + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', contacto: email, password: 'password123' })
    });
    const loginFailData = await loginFail.json();
    console.log('Login (Unverified):', loginFail.status, loginFailData);
    if (loginFail.status !== 403) console.error('❌ Expected 403');

    // D) Manual Verify (Direct DB hack only to get token, simulating User clicking link)
    // We can't access DB easily here without library, but we can verify endpoint logic if we had token.
    // For this test, we read the log output or query DB using executeSync.

    // Extract token from DB via helper script
    let verifyToken = '';
    try {
        // Simple one-liner to get token using better-sqlite3 via node -e
        const cmd = `node -e "const db=require('better-sqlite3')('${DB_PATH}'); const row=db.prepare('SELECT verification_token FROM drivers WHERE contacto=\\'${email}\\'').get(); console.log(row.verification_token);"`;
        verifyToken = execSync(cmd).toString().trim();
        console.log('Extracted Token:', verifyToken);
    } catch (e) {
        console.error('❌ Could not extract token:', e.message);
    }

    // F) Verify
    const verifyRes = await fetch(`${baseUrl}/verify-email?token=${verifyToken}`);
    const verifyTxt = await verifyRes.text();
    console.log('Verify Status:', verifyRes.status);
    if (!verifyTxt.includes('Email Verificado con Éxito')) console.error('❌ Verify HTML mismatch');

    // G) Login (Should Success)
    const loginOk = await fetch(baseUrl + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driver', contacto: email, password: 'password123' })
    });
    const loginOkData = await loginOk.json();
    console.log('Login (Verified):', loginOk.status, loginOkData.ok);

    server.kill();
    process.exit(0);
}

runTests();

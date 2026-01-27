const { spawn, execSync } = require('child_process');
const fs = require('fs');

const DB_PATH = 'repro_company.db';
const PORT = '3003';
const API_URL = `http://localhost:${PORT}`;

// 0. Clean Setup
try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
} catch (e) { }

// 1. Initialize DB
const env = {
    ...process.env,
    DB_PATH,
    PORT,
    // Using strict valid email to avoid potential filtering issues in real SendGrid, though we use fake key here
    SENDGRID_API_KEY: 'SG.FAKE_KEY_LONG_ENOUGH_TEST_XXXX',
    FROM_EMAIL: 'no-reply@driverflow.app'
};

try {
    console.log('--- Init DB ---');
    execSync('node migrate_phase1.js', { env, stdio: 'inherit' });
    execSync('node migrate_phase2.js', { env, stdio: 'inherit' });
    execSync('node migrate_phase3.js', { env, stdio: 'inherit' });
} catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
}

// 2. Start Server
console.log('--- Starting Server ---');
const server = spawn('node', ['server.js'], { env, stdio: 'pipe' });

server.stdout.on('data', d => {
    const s = d.toString();
    // Filter noise
    if (!s.includes('Processing') && !s.includes('Worker')) console.log(`[SERVER] ${s.trim()}`);
    // Capture email sent log
    if (s.includes('✅ Sent event')) console.log(`✅ FOUND EMAIL SENT LOG: ${s.trim()}`);
    if (s.includes('❌ Failed event')) console.error(`❌ FOUND FAILED LOG: ${s.trim()}`);
});
server.stderr.on('data', d => console.error(`[ERR] ${d.toString().trim()}`));

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runTest() {
    console.log('Waiting for server...');
    await wait(5000);

    const email = `company_${Date.now()}@example.com`;
    console.log(`Registering Company: ${email}`);

    try {
        const res = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'empresa',
                nombre: 'Test Company',
                contacto: email,
                password: 'password123',
                legal_name: 'Test Corp',
                address_line1: '123 St',
                address_city: 'City'
            })
        });
        const data = await res.json();
        console.log('Register Response:', res.status, data);

        if (res.status === 200 && data.require_email_verification) {
            console.log('waiting for worker to process...');
            await wait(12000); // Poll is 10s
        } else {
            console.error('Registration failed or unexpected response');
        }

    } catch (e) {
        console.error('Test Error:', e);
    }

    server.kill();
    process.exit(0);
}

runTest();

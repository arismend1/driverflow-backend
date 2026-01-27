const http = require('http');
const { spawn } = require('child_process');

console.log('--- TEST RESET WEB ---');
const env = { ...process.env, DB_PATH: 'repro.db', PORT: '3002', SENDGRID_API_KEY: 'SG.FAKE_KEY_LONG_ENOUGH_TEST_XXXX', FROM_EMAIL: 'no-reply@driverflow.app' };

const server = spawn('node', ['server.js'], { env, stdio: 'pipe' });
server.stdout.on('data', d => { });

setTimeout(async () => {
    try {
        const res = await fetch('http://localhost:3002/reset-password-web?token=test_token_123');
        if (res.status === 200) {
            const text = await res.text();
            if (text.includes('<form id="resetForm">')) {
                console.log('✅ Endpoint Works (200 OK + Form found)');
            } else {
                console.log('❌ Endpoint 200 but missing form');
                console.log(text.substring(0, 100));
            }
        } else {
            console.log('❌ Endpoint Failed:', res.status);
        }
    } catch (e) {
        console.log('❌ Connection Failed:', e.message);
    }
    server.kill();
    process.exit(0);
}, 3000);

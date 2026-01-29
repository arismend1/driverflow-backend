// Native fetch
const PORT = 3006;
const ADMIN_SECRET = 'test_secret';

const { spawn } = require('child_process');

const env = {
    ...process.env,
    PORT: PORT.toString(),
    ADMIN_SECRET,
    NODE_ENV: 'test',
    JWT_SECRET: 'dummy',
    METRICS_TOKEN: 'dummy',
    SENDGRID_API_KEY: 'SG.dummy',
    FROM_EMAIL: 'test@example.com'
};
delete env.DATABASE_URL; // Force SQLite or mock if needed (server needs DB to start)
// Actually server needs DB. If no DB_PATH, it fails.
env.DB_PATH = './test_verify_header.db';

console.log('Starting server for Header Check...');
const server = spawn('node', ['server.js'], { env, cwd: process.cwd() });

let ready = false;
server.stdout.on('data', d => {
    if (d.toString().includes('Server running')) {
        ready = true;
        check();
    }
});

async function check() {
    try {
        // 1. Query Param (Should Fail now)
        const r1 = await fetch(`http://localhost:${PORT}/admin/metrics?secret=${ADMIN_SECRET}`);
        console.log(`Query Param: ${r1.status} (Expected 403)`);

        // 2. Header (Should Succeed)
        const r2 = await fetch(`http://localhost:${PORT}/admin/metrics`, {
            headers: { 'x-admin-secret': ADMIN_SECRET }
        });
        console.log(`Header: ${r2.status} (Expected 200)`);

        if (r1.status === 403 && r2.status === 200) {
            console.log('SUCCESS: Header security confirmed.');
            process.exit(0);
        } else {
            console.error('FAIL: Security check failed.');
            process.exit(1);
        }

    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        server.kill();
    }
}

setTimeout(() => { if (!ready) { server.kill(); process.exit(1); } }, 5000);

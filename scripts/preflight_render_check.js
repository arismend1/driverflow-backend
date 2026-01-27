const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

console.log('--- Render Preflight Check ---');

// 1. Env Var Check
const requiredEnv = ['JWT_SECRET', 'SENDGRID_API_KEY', 'FROM_EMAIL', 'DB_PATH'];
const missing = requiredEnv.filter(key => !process.env[key]);

if (missing.length > 0) {
    console.error(`ERROR: Missing critical environment variables: ${missing.join(', ')}`);
    process.exit(1);
} else {
    console.log('OK: Critical environment variables present.');
}

// 2. DB Persistence Check
const dbPath = process.env.DB_PATH;
console.log(`INFO: DB_PATH is set to: ${dbPath}`);

// Heuristic: On Render, persistent disk is usually mounted at /var/data or /data or /opt/render/project/src/data
// If DB_PATH is just "driverflow.db" (relative), it will be wiped on deploy.
// We warn if it looks ephemeral (not starting with /var/data or absolute path to mount).
// But for now, we just check *writeability*.

try {
    const dir = path.dirname(dbPath);
    const testFile = path.join(dir, 'perm_test_' + Date.now());

    fs.writeFileSync(testFile, 'write_test');
    fs.unlinkSync(testFile);
    console.log(`OK: Write permission confirmed in ${dir}`);
} catch (e) {
    console.error(`ERROR: Cannot write to DB directory ${path.dirname(dbPath)}: ${e.message}`);
    process.exit(1);
}

// 3. Database Connection Check
try {
    const db = new Database(dbPath, { timeout: 5000 });
    const row = db.prepare('SELECT 1').get();
    console.log('OK: Database connection successful.');
    db.close();
} catch (e) {
    console.error(`ERROR: Database connection failed: ${e.message}`);
    process.exit(1);
}

// 4. Worker Check (Optional heuristic)
// We might check if process_outbox_emails.js exists to warn user to delete it?
if (fs.existsSync(path.join(__dirname, '../process_outbox_emails.js'))) {
    console.warn('WARNING: process_outbox_emails.js exists. Ensure it is NOT started by start script.');
}

console.log('--- Preflight Check Passed ---');
process.exit(0);

const { execSync } = require('child_process');

const DB_PATH = 'C:\\DriverFlow\\data\\driverflow_prod.db';
const tables = [
    'drivers', 'empresas', 'potential_matches', 'matches', 'tickets',
    'solicitudes', 'ratings', 'driver_profiles', 'company_requirements',
    'company_match_prefs', 'invoices', 'invoice_items', 'events_outbox',
    'jobs_queue', 'audit_logs', 'admin_audit_log', 'invoices',
    'metrics_snapshot', 'request_visibility', 'webhook_events',
    'credit_notes', 'password_resets', 'email_verifications',
    'worker_heartbeat', 'stripe_webhook_events', 'admin_users'
];

console.log("--- Starting Verbose Database Wipe ---");

tables.forEach(table => {
    try {
        console.log(`Deleting from ${table}...`);
        execSync(`sqlite3 ${DB_PATH} "DELETE FROM ${table};"`);
        console.log(`✅ ${table} cleared.`);
    } catch (e) {
        console.warn(`⚠️ Error clearing ${table}: ${e.message}`);
    }
});

try {
    console.log("Resetting sqlite_sequence...");
    execSync(`sqlite3 ${DB_PATH} "DELETE FROM sqlite_sequence;"`);
    console.log("✅ Sequences reset.");
} catch (e) {
    console.warn(`⚠️ Error resetting sequences: ${e.message}`);
}

console.log("\n--- Verification Counts ---");
const verifyTables = ['drivers', 'empresas', 'potential_matches', 'matches', 'tickets', 'events_outbox'];
verifyTables.forEach(table => {
    try {
        const count = execSync(`sqlite3 ${DB_PATH} "SELECT count(*) FROM ${table};"`).toString().trim();
        console.log(`${table}: ${count}`);
    } catch (e) {
        console.warn(`⚠️ Error counting ${table}: ${e.message}`);
    }
});

console.log("\n--- Wipe Complete ---");

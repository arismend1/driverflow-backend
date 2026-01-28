const { execSync } = require('child_process');
const path = require('path');

// Helper to run scripts
const run = (scriptName) => {
    console.log(`\n=== Running ${scriptName} ===`);
    try {
        // Inherit stdio to see output, use current env (with DB_PATH)
        execSync(`node ${scriptName}`, { stdio: 'inherit', env: process.env });
    } catch (e) {
        console.error(`❌ Failed to run ${scriptName}`);
        process.exit(1);
    }
};

console.log(`Starting Full Database Migration...`);

// 1. SAFE DEFAULT HANDLING
let dbPath = process.env.DB_PATH;
if (!dbPath) {
    const defaultDb = path.join(__dirname, 'driverflow_dev.db');
    console.log(`⚠️  NOTICE: DB_PATH not set. Using safe default for DEV: "${defaultDb}"`);
    process.env.DB_PATH = defaultDb;
    dbPath = defaultDb;
}

const resolvedDbPath = path.resolve(dbPath);
console.log(`Target DB: ${resolvedDbPath}`);

// 2. PRODUCTION SAFETY GUARD
const rawEnv = process.env.NODE_ENV || 'development';
const env = rawEnv.trim().toLowerCase();
const isProdEnv = (env === 'production' || env === 'prod');
const allowProd = process.env.ALLOW_PROD_MIGRATIONS === '1';

// Normalize path for robust Windows check (lowercase + backslashes)
// Ensure valid backslashes for Windows path comparison
const normalizedPath = resolvedDbPath.toLowerCase().replace(/\//g, '\\');

// Strict PROD detection logic:
// - Contains \DriverFlow\data\ (Standard Prod Location)
// - OR Ends with \driverflow_prod.db (Standard Prod Filename)
const isProdPath = normalizedPath.includes('\\driverflow\\data\\') || normalizedPath.endsWith('\\driverflow_prod.db');

// ABORT RULE: If targeting PROD, REQUIRE both (Prod Env AND Allow Flag)
if (isProdPath && (!isProdEnv || !allowProd)) {
    console.error(`
    🚨 FATAL ERROR: SAFETY GUARD TRIGGERED 🚨

    You are attempting to migrate a PRODUCTION database:
    "${resolvedDbPath}"

    Guard Status:
    - Environment: "${rawEnv}" (Normalized: ${env}) [Required: production/prod]
    - ALLOW_PROD_MIGRATIONS: "${process.env.ALLOW_PROD_MIGRATIONS}" [Required: 1]

    ACTION REQUIRED:
    To migrate PROD, you must explicitly set BOTH:
    1. NODE_ENV=production
    2. ALLOW_PROD_MIGRATIONS=1

    Operation ABORTED to protect data.
    `);
    process.exit(1);
}

// 3. RUN MIGRATIONS
// Core Schema (Phase 1 implicit in database.js)
// migrate_phase1.js just requires database.js
run('migrate_phase1.js');

// Legacy Features (Phase 2 & 3: Lifecycle, Gating, Tiers)
run('migrate_phase2.js');
run('migrate_phase3.js');

// New Modules (Tickets, Billing, Events, Delinquency, Emails)
run('migrate_phase_tickets.js');
run('migrate_phase_billing.js');
run('migrate_phase_events.js');
run('migrate_phase_delinquency.js');
run('migrate_phase_email_outbox.js');
run('migrate_phase_onboarding.js');
run('migrate_phase_matching.js');
run('migrate_phase_prod.js'); // Ensure Prod Config (A) is last or near last

console.log(`\n✅ All migrations completed successfully.`);

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Check for DATABASE_URL
if (!process.env.DATABASE_URL) {
    console.error("❌ Error: DATABASE_URL environment variable is missing.");
    console.error("   Please set it before running this script.");
    console.error("   Example: $env:DATABASE_URL='postgres://...'");
    process.exit(1);
}

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render/Cloud DBs often
});

async function runMigration() {
    try {
        console.log("🔌 Connecting to database...");
        await client.connect();
        console.log("✅ Connected.");

        // Read the SQL file
        const sqlPath = path.join(__dirname, 'manual_migration_phase13_hardening.sql');
        console.log(`📖 Reading SQL from: ${sqlPath}`);

        if (!fs.existsSync(sqlPath)) {
            throw new Error(`SQL file not found at ${sqlPath}`);
        }

        const sql = fs.readFileSync(sqlPath, 'utf8');

        // Split by semicolon to run statements sequentially if needed, 
        // but pg driver can often handle multiple statements. 
        // For safety/clarity, we'll run it as one transaction block.

        console.log("🚀 Executing migration...");

        await client.query('BEGIN');

        // Execute the raw SQL
        await client.query(sql);

        // Verification step (optional but good)
        const res = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'invoices' 
            AND column_name IN ('stripe_payment_intent_id', 'paid_at', 'failure_reason', 'attempt_count', 'last_error');
        `);

        console.log("🔎 Verification - Found new columns:", res.rows.map(r => r.column_name));

        await client.query('COMMIT');
        console.log("✅ Migration applied successfully and committed.");

    } catch (err) {
        console.error("❌ Migration FAILED. Rolling back.");
        await client.query('ROLLBACK');
        console.error(err);
    } finally {
        await client.end();
        console.log("🔌 Disconnected.");
    }
}

runMigration();

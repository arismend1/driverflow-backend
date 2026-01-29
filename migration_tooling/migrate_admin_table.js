require('dotenv').config();
const { Client } = require('pg');

const IS_POSTGRES = !!process.env.DATABASE_URL;

if (!IS_POSTGRES) {
    console.error("Skipping: Not Postgres environment");
    process.exit(0);
}

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const SQL = `
    CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER,
        action TEXT NOT NULL,
        target_resource TEXT,
        target_id TEXT,
        ip_address TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        details TEXT
    );
`;

(async () => {
    try {
        await client.connect();
        console.log("Connected to Postgres. Creating Admin Tables...");
        await client.query(SQL);
        console.log("✅ Admin tables created successfully.");
        await client.end();
    } catch (e) {
        console.error("❌ Migration Failed:", e);
        process.exit(1);
    }
})();

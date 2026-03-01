require('dotenv').config();
const { Pool } = require('pg');

async function migrate() {
    console.log("Starting Migration: Add availability to drivers");

    // PostgreSQL Migration
    if (process.env.DATABASE_URL) {
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });

        try {
            await pool.query("ALTER TABLE drivers ADD COLUMN availability VARCHAR(50) DEFAULT 'Inmediata'");
            console.log("✅ Added availability column (Postgres).");
        } catch (e) {
            if (e.code === '42701') console.log("⚠️ Column availability already exists (Postgres).");
            else console.error("❌ Error (Postgres):", e.message);
        } finally {
            await pool.end();
        }
    }

    // SQLite Migration (Local)
    try {
        const Database = require('better-sqlite3');
        const db = new Database(process.env.DB_PATH || 'driverflow.db');
        db.prepare("ALTER TABLE drivers ADD COLUMN availability TEXT DEFAULT 'Inmediata'").run();
        console.log("✅ Added availability column (SQLite).");
    } catch (e) {
        if (e.message && e.message.includes('duplicate column')) {
            console.log("⚠️ Column availability already exists (SQLite).");
        } else {
            console.error("❌ Error (SQLite):", e.message);
        }
    }

    console.log("Migration finished.");
    process.exit(0);
}

migrate();

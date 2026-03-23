const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const isPostgres = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('pointer.pgadmin.builtwithkoala.com');

async function migrate() {
    if (isPostgres) {
        console.log("Migrating PostgreSQL...");
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });

        try {
            await pool.query(`
                ALTER TABLE drivers ADD COLUMN IF NOT EXISTS willing_travel_interview BOOLEAN DEFAULT FALSE;
                ALTER TABLE company_requirements ADD COLUMN IF NOT EXISTS requires_travel_interview BOOLEAN DEFAULT FALSE;
            `);
            console.log("PostgreSQL migration successful.");
        } catch (err) {
            console.error("PostgreSQL migration failed:", err);
        } finally {
            await pool.end();
        }
    } else {
        console.log("Migrating SQLite...");
        const dbPath = process.env.DB_PATH || './driverflow.db';
        const db = new sqlite3.Database(dbPath);

        db.serialize(() => {
            // Check if column exists is hard in SQLite, we'll try to add it and ignore error if it exists
            db.run("ALTER TABLE drivers ADD COLUMN willing_travel_interview BOOLEAN DEFAULT 0", (err) => {
                if (err && err.message.includes("duplicate column name")) {
                    console.log("SQLite: willing_travel_interview already exists.");
                } else if (err) {
                    console.error("SQLite error (drivers):", err.message);
                } else {
                    console.log("SQLite: Added willing_travel_interview to drivers.");
                }
            });

            db.run("ALTER TABLE company_requirements ADD COLUMN requires_travel_interview BOOLEAN DEFAULT 0", (err) => {
                if (err && err.message.includes("duplicate column name")) {
                    console.log("SQLite: requires_travel_interview already exists.");
                } else if (err) {
                    console.error("SQLite error (company_requirements):", err.message);
                } else {
                    console.log("SQLite: Added requires_travel_interview to company_requirements.");
                }
            });
        });

        db.close();
    }
}

migrate();

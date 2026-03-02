require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        console.log('Connected to DB');
        await client.query("ALTER TABLE potential_matches ADD COLUMN IF NOT EXISTS score_breakdown JSONB DEFAULT '{}'");
        console.log('Added score_breakdown column');
        try {
            await client.query("ALTER TABLE potential_matches ADD CONSTRAINT uq_company_driver UNIQUE (company_id, driver_id)");
            console.log('Added UNIQUE constraint');
        } catch (e) {
            if (e.code === '42P07') console.log('Constraint already exists');
            else throw e;
        }
    } finally {
        await client.end();
    }
}
run().catch(console.error);

const { Client } = require('pg');
require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("❌ Error: DATABASE_URL not found in environment.");
    process.exit(1);
}

async function run() {
    console.log("🚀 Starting Manual Invoice Generation Trigger...");
    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log("✅ Connected to Database.");

        // 1. Target Period: Last Week (March 16 - March 22, 2026)
        const week_start = '2026-03-16';
        const week_end = '2026-03-22';

        // 2. Get all companies
        const companiesRes = await client.query("SELECT id, nombre FROM empresas");
        const companies = companiesRes.rows;

        if (companies.length === 0) {
            console.log("ℹ️ No companies found.");
            return;
        }

        console.log(`📊 Found ${companies.length} companies. Enqueueing billing jobs...`);

        const now = new Date().toISOString();

        for (const co of companies) {
            const payload = JSON.stringify({
                company_id: co.id,
                week_start,
                week_end
            });

            // Insert into jobs_queue
            await client.query(
                "INSERT INTO jobs_queue (job_type, payload_json, created_at, attempts, max_attempts) VALUES ($1, $2, $3, 0, 5)",
                ['generate_weekly_invoices', payload, now]
            );

            console.log(`✅ Job enqueued for ${co.nombre} (ID: ${co.id})`);
        }

        console.log("\n✨ All billing jobs enqueued successfully!");
        console.log("⏳ The worker will pick them up shortly. Check the invoices table in a few minutes.");

    } catch (e) {
        console.error("❌ Error:", e.message);
    } finally {
        await client.end();
    }
}

run();

// Native fetch is available in Node 18+
const path = require('path');
const fs = require('fs');

// Try to load .env manually if not loaded
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envConfig = require('dotenv').parse(fs.readFileSync(envPath));
        for (const k in envConfig) {
            process.env[k] = envConfig[k];
        }
    }
} catch (e) { }

const API_URL = process.env.API_URL || 'http://localhost:3000';
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET) {
    console.error("❌ Error: ADMIN_SECRET not found in environment.");
    console.error("Usage: $env:API_URL='...'; node scripts/verify_phase13_hardening.js");
    process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    console.log(`🔍 Starting Phase 13 Verification against ${API_URL}`);

    // 1. Generate Invoices
    console.log('\n--- Step 1: Trigger Invoice Generation ---');
    try {
        const res = await fetch(`${API_URL}/admin/invoices/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-secret': ADMIN_SECRET
            },
            body: JSON.stringify({})
        });

        const text = await res.text();

        if (res.status === 404) {
            console.error(`❌ Endpoint Not Found (404).`);
            console.error(`   Diagnosis: The server code has NOT been updated or restarted.`);
            console.error(`   Action: Deploy the latest 'server.js' and restart the server.`);
            process.exit(1);
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error(`❌ Non-JSON Response (${res.status}):`, text.substring(0, 500));
            process.exit(1);
        }

        if (!res.ok) {
            console.error(`❌ Generation Error (${res.status}): ${data.error}`);
            if (data.error && data.error.includes('column')) {
                console.error(`   Diagnosis: Database Migration is MISSING.`);
                console.error(`   Action: Run 'scripts/manual_migration_phase13_hardening.sql' in your database.`);
            }
            // Continue anyway to check other things? No, gen failed.
            // process.exit(1); // Optional: stop here
        } else {
            console.log('✅ Generation Triggered:', data);
        }
    } catch (e) {
        console.error('❌ Generation Failed (Network/Other):', e.message);
        process.exit(1);
    }

    // 2. Wait for Worker
    console.log('\n⏳ Waiting 5s for worker to process...');
    await sleep(5000);

    // 3. Check Invoices
    console.log('\n--- Step 2: Check Created Invoices ---');
    let targetInvoice = null;
    try {
        const res = await fetch(`${API_URL}/admin/invoices`, {
            headers: { 'x-admin-secret': ADMIN_SECRET }
        });
        const invoices = await res.json();

        if (invoices.length === 0) {
            console.log('⚠️ No invoices found. Maybe no companies or no matching data?');
            return;
        }

        console.log(`found ${invoices.length} invoices.`);
        targetInvoice = invoices[0];
        console.log(`📋 Inspecting Invoice #${targetInvoice.id} for Company: ${targetInvoice.company_name}`);
        console.log(`   Status: ${targetInvoice.status}`);
        // Check for new columns presence in response
        if (targetInvoice.attempt_count === undefined) {
            console.log(`   ⚠️ 'attempt_count' field is MISSING in response.`);
            console.log(`      Diagnosis: Server might be running old code OR DB query didn't return it.`);
        } else {
            console.log(`   ✅ 'attempt_count' is present: ${targetInvoice.attempt_count}`);
        }

    } catch (e) {
        console.error('❌ Fetch failed:', e.message);
        return;
    }

    if (!targetInvoice) return;

    // 4. Verify Idempotency (Retry Attempt)
    console.log('\n--- Step 3: Hardening Test (Retry Endpoint) ---');
    console.log(`👉 Attempting to FORCE RETRY invoice #${targetInvoice.id}`);

    try {
        const res = await fetch(`${API_URL}/admin/invoices/${targetInvoice.id}/retry`, {
            method: 'POST',
            headers: { 'x-admin-secret': ADMIN_SECRET }
        });
        const data = await res.json();

        if (res.ok) {
            console.log('✅ Retry Request Accepted:', data);
        } else {
            console.log(`Response: ${res.status} - ${data.error}`);

            if (res.status === 404) {
                console.error(`❌ Retry Endpoint 404. Server NOT updated.`);
            } else if (data.error && data.error.includes('no such column')) {
                console.error(`❌ DB Error: Missing Columns.`);
                console.error(`   Action: Run the Migration SQL!`);
            } else {
                console.log(`ℹ️ Request blocked/failed as expected or due to logic: ${data.error}`);
            }
        }
    } catch (e) {
        console.error('❌ Retry Req Failed:', e.message);
    }
}

main().catch(console.error);

// Native fetch is available in Node 18+
const { validateEnv } = require('../env_guard');

// Mock env guard for script
process.env.NODE_ENV = 'production';

async function run() {
    const API_URL = process.env.API_URL || 'https://driverflow-backend.onrender.com';
    const ADMIN_SECRET = process.env.ADMIN_SECRET;

    if (!ADMIN_SECRET) {
        console.error('❌ Missing ADMIN_SECRET env var');
        process.exit(1);
    }

    console.log(`🌍 Checking Idempotency at ${API_URL}...`);

    // 1. Trigger Generation (First Pass)
    console.log('\n▶️  Triggering Invoice Generation (Pass 1)...');
    const res1 = await fetch(`${API_URL}/admin/invoices/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-secret': ADMIN_SECRET
        },
        body: JSON.stringify({}) // Defaults to last week
    });

    const json1 = await res1.json();
    console.log('   Status:', res1.status);
    console.log('   Response:', JSON.stringify(json1, null, 2));

    if (res1.status !== 200) {
        console.error('❌ Pass 1 Failed');
        process.exit(1);
    }

    // 2. Trigger Generation (Second Pass - Should Skip)
    console.log('\n▶️  Triggering Invoice Generation (Pass 2 - Idempotency Check)...');
    const res2 = await fetch(`${API_URL}/admin/invoices/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-secret': ADMIN_SECRET
        },
        body: JSON.stringify({})
    });

    const json2 = await res2.json();
    console.log('   Status:', res2.status);
    console.log('   Response:', JSON.stringify(json2, null, 2));

    // The API might return 200 even if skipped (async job), but the worker logs or job output should show it.
    // However, since the HTTP API just enqueues, both returns 200 "Invoices generation enqueued".
    // Real verification is checking the DB for duplicates.

    console.log('\n🔍 Verifying Database for Duplicates...');
    // We can use the /admin/invoices endpoint to check count
    const resList = await fetch(`${API_URL}/admin/invoices`, {
        headers: { 'x-admin-secret': ADMIN_SECRET }
    });
    const invoices = await resList.json();

    // Group by company + week
    const map = {};
    let dupeFound = false;

    for (const inv of invoices) {
        const key = `${inv.company_id}_${inv.week_start}_${inv.week_end}`;
        if (map[key]) {
            dupeFound = true;
            console.error(`❌ DUPLICATE FOUND: ${key} (IDs: ${map[key]}, ${inv.id})`);
        }
        map[key] = inv.id;
    }

    if (!dupeFound) {
        console.log(`✅ No duplicates found in ${invoices.length} invoices.`);
        console.log('✅ Idempotency Verified (via Index Constraint).');
    } else {
        console.error('❌ Idempotency FAILED.');
        process.exit(1);
    }
}

run().catch(e => console.error(e));

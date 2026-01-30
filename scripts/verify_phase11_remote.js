const API_URL = process.env.API_URL || 'https://driverflow-backend.onrender.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET) {
    console.error("❌ ADMIN_SECRET is required env var");
    process.exit(1);
}

async function run() {
    try {
        console.log(`Target: ${API_URL}`);

        // 1. List Invoices
        console.log("1. Testing GET /admin/invoices...");
        const res1 = await fetch(`${API_URL}/admin/invoices`, {
            headers: { 'x-admin-secret': ADMIN_SECRET }
        });

        if (!res1.ok) {
            const txt = await res1.text();
            throw new Error(`List failed: ${res1.status} ${res1.statusText} - ${txt}`);
        }
        const list = await res1.json();
        console.log(`   ✅ Success. Found ${list.length} invoices.`);

        // 2. Generate Invoice (Test trigger)
        // Using a past date (Monday) to ensure we test the mechanism.
        // If your DB has no usage for this week, it will just generate a 0 invoice, which is fine for testing.
        const testDate = '2025-01-20'; // Recent Monday
        console.log(`2. Testing POST /admin/invoices/generate for ${testDate}...`);
        const res2 = await fetch(`${API_URL}/admin/invoices/generate`, {
            method: 'POST',
            headers: {
                'x-admin-secret': ADMIN_SECRET,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ week_start: testDate })
        });

        if (!res2.ok) {
            const txt = await res2.text();
            throw new Error(`Generate failed: ${res2.status} ${res2.statusText} - ${txt}`);
        }
        const genResult = await res2.json();
        console.log("   ✅ Success. Generation Triggered:", genResult);

        console.log("\n🎉 VERIFICATION PASSED: API is fully functional.");

    } catch (e) {
        console.error("❌ VERIFICATION FAILED:", e.message);
        process.exit(1);
    }
}

run();

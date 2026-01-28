// Native fetch in Node 18+

const API_URL = 'http://localhost:3003';
let companyToken, driverToken;
let companyId, driverId;

async function run() {
    console.log("--- Starting Phase 7 (Advanced Matching) Smoke Test ---");

    try {
        // 1. Setup: Register Company & Driver
        console.log("1. Registering Match Participants...");

        // Company
        const cEmail = `comp_match_${Date.now()}@test.com`;
        const resC = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Logistic Corp',
                contacto: cEmail,
                password: 'Password123!',
                type: 'empresa'
            })
        });
        const dataC = await resC.json();
        if (!resC.ok) throw new Error(`Company Register Failed: ${JSON.stringify(dataC)}`);
        // Login to get token
        // MUST VERIFY FIRST
        // Fetch token from DB directly for test speed
        const db = require('../db');
        const rowC = db.prepare('SELECT verification_token, contacto FROM empresas WHERE contacto = ?').get(cEmail);
        if (!rowC) {
            console.error("DEBUG: Company Not Found. Email:", cEmail);
            const all = db.prepare('SELECT contacto FROM empresas').all();
            console.error("DEBUG: All Empresas:", all);
            throw new Error("Company not found in DB");
        }
        console.log("DEBUG: Found Company:", rowC.contacto);
        await fetch(`${API_URL}/verify-email?token=${rowC.verification_token}`);
        console.log("   -> Company Verified.");

        const loginC = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cEmail, password: 'Password123!', type: 'empresa', contacto: cEmail })
        });
        const loginDataC = await loginC.json();
        if (!loginDataC.ok) throw new Error(`Company Login Failed: ${JSON.stringify(loginDataC)}`);
        companyToken = loginDataC.token;
        companyId = loginDataC.id; // login response has 'id', not 'user.id' based on server.js code: res.json({ ok: true, token, type, id: row.id, nombre: row.nombre });
        console.log(`   -> Company Registered & Logged In: ID ${companyId}`);

        // Driver
        const dEmail = `driver_match_${Date.now()}@test.com`;
        const resD = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Juan Perez',
                contacto: dEmail,
                password: 'Password123!',
                type: 'driver'
            })
        });
        const dataD = await resD.json();
        if (!resD.ok) throw new Error(`Driver Register Failed: ${JSON.stringify(dataD)}`);

        // Verify Driver
        const rowD = db.prepare('SELECT verification_token FROM drivers WHERE contacto = ?').get(dEmail);
        await fetch(`${API_URL}/verify-email?token=${rowD.verification_token}`);
        console.log("   -> Driver Verified.");

        // Login
        const loginD = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: dEmail, password: 'Password123!', type: 'driver', contacto: dEmail })
        });
        const loginDataD = await loginD.json();
        if (!loginDataD.ok) throw new Error(`Driver Login Failed: ${JSON.stringify(loginDataD)}`);
        driverToken = loginDataD.token;
        driverId = loginDataD.id;
        console.log(`   -> Driver Registered & Logged In: ID ${driverId}`);

        // 2. Set Company Requirements (High Standard)
        console.log("2. Setting Company Requirements...");
        const reqPayload = {
            req_cdl: true,
            req_license_types: ["A"],
            req_endorsements: ["T", "X"], // Tanker, Hazmat
            req_operation_types: ["OTR"],
            license_types: ["A"],
            endorsements: ["T", "X"], // Tanker, Hazmat
            operation_types: ["OTR"],
            offered_payment_methods: ["Mile"],
            req_relationships: ["Company Driver"],
            availability: "Immediate"
        };
        const resReq = await fetch(`${API_URL}/companies/requirements`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${companyToken}`
            },
            body: JSON.stringify(reqPayload)
        });
        if (!resReq.ok) {
            const txt = await resReq.text();
            throw new Error(`Set Requirements Failed: ${resReq.status} ${txt}`);
        }
        console.log(`   -> Requirements set: OK`);

        // 3. Set Driver Profile (Underqualified - Should NOT match)
        console.log("3. Setting Driver Profile (Underqualified)...");
        const profileBad = {
            has_cdl: true,
            license_types: ["B"], // Wrong License
            endorsements: ["T"], // Missing X
            operation_types: ["Local"], // Wrong Ops
            experience_years: 1,
            payment_methods: ["Mile"],
            work_relationships: ["Company Driver"]
        };
        const resProf = await fetch(`${API_URL}/drivers/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${driverToken}`
            },
            body: JSON.stringify(profileBad)
        });
        if (!resProf.ok) {
            const txt = await resProf.text();
            throw new Error(`Set Profile Failed: ${resProf.status} ${txt}`);
        }

        // Check Matches (Company View)
        const resMatch1 = await fetch(`${API_URL}/matches/candidates`, {
            headers: { 'Authorization': `Bearer ${companyToken}` }
        });
        const match1 = await resMatch1.json();
        console.log(`   -> Matches found (Total): ${match1.length}`);

        const isCurrentDriverMatched = match1.find(m => m.driver_id === driverId);
        if (isCurrentDriverMatched) {
            throw new Error("Error: Current (Underqualified) driver matched!");
        }
        console.log("   -> Verified: Current driver NOT matched.");

        // 4. Update Driver Profile (Qualified - Should Match)
        console.log("4. Updating Driver Profile (Qualified)...");
        const profileGood = {
            has_cdl: true,
            license_types: ["A", "B"], // Has A (Subset check: {A} defined in req is in {A, B})
            endorsements: ["T", "X", "N"], // Has T, X (Subset check: {T,X} is in {T,X,N})
            operation_types: ["OTR", "Regional"], // Has OTR
            experience_years: 5,
            payment_methods: ["Mile", "Load"],
            work_relationships: ["Company Driver"]
        };
        await fetch(`${API_URL}/drivers/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${driverToken}`
            },
            body: JSON.stringify(profileGood)
        });

        // Check Matches (Company View)
        const resMatch2 = await fetch(`${API_URL}/matches/candidates`, {
            headers: { 'Authorization': `Bearer ${companyToken}` }
        });
        const matches2 = await resMatch2.json();
        const myMatch = matches2.find(m => m.driver_id === driverId);

        console.log(`   -> Matches found (Total): ${matches2.length}`);

        if (myMatch) {
            console.log("   -> Match Data:", myMatch);
            // Strict Privacy Check
            if (myMatch.nombre || myMatch.contacto) throw new Error("Privacy Leak! Name/Contact revealed.");
            if (myMatch.display_name !== `Chofer #${driverId}`) throw new Error(`Display Name mismatch: ${myMatch.display_name}`);
            console.log("   ✅ MATCH SUCCESS & PRIVACY VERIFIED");
        } else {
            throw new Error(`Expected driver ${driverId} to match, but was not found in candidates list.`);
        }

        // Check Matches (Driver View - Opportunities)
        const resOpp = await fetch(`${API_URL}/matches/opportunities`, {
            headers: { 'Authorization': `Bearer ${driverToken}` }
        });
        const opps = await resOpp.json();
        console.log(`   -> Opportunities found (Total): ${opps.length}`);

        const myOpp = opps.find(o => o.company_id === companyId);

        if (myOpp) {
            console.log("   -> Opportunity Data:", myOpp);
            // Verify UX Fields
            if (!myOpp.op_types || !myOpp.pay_methods) throw new Error("UX Fields missing (op_types/pay_methods)");
            console.log("   ✅ DRIVER SEES OPPORTUNITY & UX FIELDS");
        } else {
            throw new Error("Driver did not see the matching company");
        }

    } catch (e) {
        console.error("❌ TEST FAILED:", e);
        process.exit(1);
    }
}

run();

const axios = require('axios');

const API_URL = 'https://driverflow-backend.onrender.com';
const SECRET = 'surgical_evidence_123';

const timestamp = Date.now();
const driverEmail = `proddrv_${timestamp}@test.com`;
const companyEmail = `prodco_${timestamp}@test.com`;

const driver = {
    type: 'driver',
    nombre: `Prod Driver ${timestamp}`,
    contacto: driverEmail,
    phone: `555${timestamp.toString().slice(-7)}`,
    password: 'Password123!',
    tipo_licencia: 'A'
};

const company = {
    type: 'empresa',
    nombre: `Prod Co ${timestamp}`,
    contacto: companyEmail,
    phone: `666${timestamp.toString().slice(-7)}`,
    password: 'Password123!',
    ciudad: 'CDMX'
};

async function getSqlEvidence(stepName) {
    console.log(`\n--- SQL EVIDENCE: ${stepName} ---`);
    const res = await axios.post(`${API_URL}/api/debug/sql`, {
        secret: SECRET,
        emails: [driverEmail, companyEmail]
    });

    console.log("SELECT id, nombre, email, contacto, phone, verified, status FROM drivers ORDER BY id DESC LIMIT 5;");
    console.table(res.data.drivers);

    console.log("\nSELECT id, nombre, email, contacto, telefono, contact_phone, account_state, verified FROM empresas ORDER BY id DESC LIMIT 5;");
    console.table(res.data.empresas);
    console.log("-------------------------------------------\n");
    return res.data.tokens;
}

// Polling until Render is up with the NEW code
async function waitForRender() {
    console.log("Waiting for Render to boot new deployment (checking new endpoint)...");
    for (let i = 0; i < 40; i++) {
        try {
            const res = await axios.post(API_URL + '/api/debug/sql', { secret: SECRET });
            if (res.status === 200) {
                console.log("✅ Render is UP with NEW code!");
                return;
            }
        } catch (e) {
            if (e.response && (e.response.status === 403 || e.response.status === 200)) {
                console.log("✅ Render is UP with NEW code!");
                return;
            }
        }
        process.stdout.write(".");
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error("Render didn't boot in time.");
}

async function run() {
    try {
        await waitForRender();
        await new Promise(r => setTimeout(r, 5000)); // wait a bit more for migrations

        console.log("\n0. Forcing Migrations via API...");
        try {
            await axios.post(`${API_URL}/api/debug/sql`, { secret: SECRET, run_migrations: true });
            console.log("✅ Migrations manually executed or already exist.");
        } catch (e) {
            console.error("❌ Failed to force migrations:", e.message);
        }

        console.log("\n1. Registering Driver & Company...");
        await axios.post(`${API_URL}/register`, driver);
        await axios.post(`${API_URL}/register`, company);
        console.log("✅ Registration endpoints returned success.");

        const tokens = await getSqlEvidence("AFTER REGISTRATION");

        console.log("\n2. Testing Early Login (Should be blocked)...");
        try {
            await axios.post(`${API_URL}/login`, { type: 'driver', contacto: driver.contacto, password: driver.password });
            console.error("❌ ERROR: Driver login succeeded when it should be blocked!");
        } catch (e) {
            console.log("✅ Driver Login Blocked:", e.response?.data?.error || e.message);
        }

        try {
            await axios.post(`${API_URL}/login`, { type: 'empresa', contacto: company.contacto, password: company.password });
            console.error("❌ ERROR: Company login succeeded when it should be blocked!");
        } catch (e) {
            console.log("✅ Company Login Blocked:", e.response?.data?.error || e.message);
        }

        const dToken = tokens[driverEmail];
        const cToken = tokens[companyEmail];

        console.log("\n3. Calling /verify-email...");
        await axios.get(`${API_URL}/verify-email?token=${dToken}`);
        await axios.get(`${API_URL}/verify-email?token=${cToken}`);
        console.log("✅ Emails verified successfully via endpoint.");

        await getSqlEvidence("AFTER VERIFICATION");

        console.log("\n4. Testing Final Login (Should Succeed)...");
        const dLogin = await axios.post(`${API_URL}/login`, { type: 'driver', contacto: driver.contacto, password: driver.password });
        console.log("✅ Driver Login Success, Token length:", dLogin.data?.token?.length);

        const cLogin = await axios.post(`${API_URL}/login`, { type: 'empresa', contacto: company.contacto, password: company.password });
        console.log("✅ Company Login Success, Token length:", cLogin.data?.token?.length);

        console.log("\nAll Done!");
        process.exit(0);

    } catch (err) {
        console.error("Test execution failed:", err.message);
        if (err.response) console.error("API response:", JSON.stringify(err.response.data));
        process.exit(1);
    }
}

run();

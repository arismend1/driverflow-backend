const axios = require('axios');
const { execSync } = require('child_process');

const API_URL = 'http://localhost:3000';
const DB_PATH = 'C:\\DriverFlow\\data\\driverflow_prod.db';

async function testFlow() {
    console.log("--- Starting Email Verification Flow Test ---");

    const driver = {
        type: 'driver',
        nombre: 'Verify Test Driver',
        contacto: 'verify@test.com',
        phone: '9998887777',
        password: 'Password123!',
        tipo_licencia: 'A'
    };

    try {
        console.log("1. Registering Driver (Should be unverified)...");
        await axios.post(`${API_URL}/register`, driver);

        console.log("2. Attempting Login (Should FAIL with 403)...");
        try {
            await axios.post(`${API_URL}/login`, {
                type: 'driver',
                contacto: driver.contacto,
                password: driver.password
            });
            console.error("❌ ERROR: Login succeeded for unverified user!");
        } catch (e) {
            console.log("✅ SUCCESS: Login blocked. Error:", e.response?.data?.error);
        }

        console.log("\n3. Checking DB for Token...");
        const dbData = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, contacto, verified, verification_token, verification_expires FROM drivers WHERE contacto='${driver.contacto}'"`).toString();
        console.log(dbData);

        const tokenMatch = dbData.match(/[a-f0-9]{64}/);
        if (!tokenMatch) {
            console.error("❌ ERROR: No token found in DB.");
            return;
        }
        const token = tokenMatch[0];
        console.log("Found Token:", token);

        console.log("\n4. Verifying Email via Endpoint...");
        const verifyRes = await axios.get(`${API_URL}/verify-email?token=${token}`);
        console.log("Verify Response:", verifyRes.data.substring(0, 50), "...");

        console.log("\n5. Attempting Login Again (Should SUCCEED)...");
        const loginRes = await axios.post(`${API_URL}/login`, {
            type: 'driver',
            contacto: driver.contacto,
            password: driver.password
        });
        console.log("✅ SUCCESS: Login worked! Token length:", loginRes.data.token.length);

        console.log("\n6. Final DB Check (verified should be 1, token should be NULL)...");
        const finalDb = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, contacto, verified, verification_token FROM drivers WHERE contacto='${driver.contacto}'"`).toString();
        console.log(finalDb);

    } catch (e) {
        console.error("Test Failed:", e.response?.data || e.message);
        if (e.stack) console.error(e.stack);
    }
}

testFlow();

const axios = require('axios');
const { execSync } = require('child_process');

const API_URL = 'http://localhost:3000';
const DB_PATH = 'C:\\DriverFlow\\data\\driverflow_prod.db';

async function verify() {
    console.log("--- Starting Real Registration Test ---");

    const driver = {
        type: 'driver',
        nombre: 'Real Test Driver',
        contacto: 'real_driver@test.com', // email
        phone: '1112223333',
        password: 'Password123!',
        tipo_licencia: 'A'
    };

    const company = {
        type: 'empresa',
        nombre: 'Real Test Co',
        contacto: 'real_company@test.com', // email
        phone: '4445556666',
        password: 'Password123!',
        legal_name: 'Real Co S.A.'
    };

    try {
        console.log("1. Registering Driver...");
        await axios.post(`${API_URL}/register`, driver);

        console.log("2. Registering Company...");
        await axios.post(`${API_URL}/register`, company);

        console.log("\n3. Inspecting Driver Table (Last 1):");
        const driverData = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, nombre, contacto, phone, verified, status FROM drivers ORDER BY id DESC LIMIT 1"`).toString();
        console.log(driverData);

        console.log("\n4. Inspecting Empresa Table (Last 1):");
        const companyData = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, nombre, contacto, contact_phone, account_state, verified FROM empresas ORDER BY id DESC LIMIT 1"`).toString();
        console.log(companyData);

        // EXTRA: Check if 'email' column exists and is NULL (to disprove it or prove it)
        try {
            console.log("\n5. Checking if 'email' column exists in drivers:");
            const emailCheck = execSync(`sqlite3 ${DB_PATH} "SELECT email FROM drivers LIMIT 1"`).toString();
            console.log("Email value:", emailCheck || 'NULL or Empty');
        } catch (e) {
            console.log("Column 'email' DOES NOT EXIST in this SQLite DB.");
        }

    } catch (e) {
        console.error("Test Failed:", e.response?.data || e.message);
    }
}

verify();

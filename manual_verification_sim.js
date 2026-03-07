const { execSync } = require('child_process');
const crypto = require('crypto');

const DB_PATH = 'C:\\DriverFlow\\data\\driverflow_prod.db';

function nowIso() { return new Date().toISOString(); }
function nowEpochMs() { return Date.now(); }

async function simulate() {
    console.log("--- Simulating Email Verification SQL Flow ---");

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(nowEpochMs() + 24 * 3600 * 1000).toISOString();
    const now = nowIso();

    console.log("1. Simulating Register (Setting verified=0)...");
    execSync(`sqlite3 ${DB_PATH} "INSERT INTO drivers (nombre, contacto, phone, password_hash, tipo_licencia, status, created_at, verified, verification_token, verification_expires) VALUES ('Final Test Driver', 'final@test.com', '1234567890', 'hash', 'B', 'active', '${now}', 0, '${token}', '${expires}');"`);
    execSync(`sqlite3 ${DB_PATH} "INSERT INTO empresas (nombre, contacto, contact_phone, password_hash, legal_name, address_line1, city, ciudad, verified, account_state, verification_token, verification_expires, created_at) VALUES ('Final Test Co', 'final_co@test.com', '0987654321', 'hash', 'Final Co S.A.', '', '', '', 0, 'ACTIVE', '${token}', '${expires}', '${now}');"`);

    console.log("\n2. Evidence: Data immediately after registration (Unverified):");
    const drivers = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, contacto as email, verified, verification_token, verification_expires FROM drivers ORDER BY id DESC LIMIT 1"`).toString();
    console.log("DRIVERS:\n", drivers);

    const companies = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, contacto as email, verified, verification_token, verification_expires FROM empresas ORDER BY id DESC LIMIT 1"`).toString();
    console.log("EMPRESAS:\n", companies);

    console.log("\n3. Simulating Verification (Updating verified=1)...");
    execSync(`sqlite3 ${DB_PATH} "UPDATE drivers SET verified=1, verification_token=NULL WHERE contacto='final@test.com';"`);
    execSync(`sqlite3 ${DB_PATH} "UPDATE empresas SET verified=1, verification_token=NULL WHERE contacto='final_co@test.com';"`);

    console.log("\n4. Evidence: Data after verification (Verified):");
    const driversVerify = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, contacto as email, verified, verification_token FROM drivers WHERE contacto='final@test.com'"`).toString();
    console.log("DRIVERS:\n", driversVerify);

    const companiesVerify = execSync(`sqlite3 -header -column ${DB_PATH} "SELECT id, contacto as email, verified, verification_token FROM empresas WHERE contacto='final_co@test.com'"`).toString();
    console.log("EMPRESAS:\n", companiesVerify);

    console.log("\n--- Simulation Complete ---");
}

simulate();

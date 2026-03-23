const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

const timestamp = Date.now();

async function run() {
    try {
        console.log("Testing Driver Insert...");
        const dRes = await pool.query(
            `INSERT INTO drivers (nombre, email, phone, password_hash, tipo_licencia, status, created_at, verified, verify_token_hash, verify_token_expires_at) VALUES ($1,$2,$3,$4,$5,'active',$6,false,$7,$8) RETURNING id`,
            ['Test Driver', `testdrv_${timestamp}@test.com`, '5551234567', 'hash', 'B', new Date().toISOString(), 'token', new Date().toISOString()]
        );
        console.log("Driver Insert Success:", dRes.rows[0].id);

        console.log("Testing Company Insert...");
        const cRes = await pool.query(
            `INSERT INTO empresas (nombre, email, contacto, telefono, password_hash, legal_name, address_line1, city, ciudad, verified, account_state, verify_token_hash, verify_token_expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,'ACTIVE',$10,$11,$12) RETURNING id`,
            ['Test Co', `testco_${timestamp}@test.com`, `testco_${timestamp}@test.com`, '6661234567', 'hash', 'Test Co', 'line1', 'city', 'city', 'token', new Date().toISOString(), new Date().toISOString()]
        );
        console.log("Company Insert Success:", cRes.rows[0].id);

        process.exit(0);
    } catch (e) {
        console.error("DB Error:", e.message);
        process.exit(1);
    }
}
run();

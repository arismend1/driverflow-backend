const { Pool } = require('pg');

const DB_URL = 'postgres://driverflow_user:tG0rYfIKhX70Y8EaYIAnbL9r9Siz4Yf4@dpg-cuh7m72j1k6c738m8h1g-a.oregon-postgres.render.com/driverflow';

const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
});

async function run() {
    try {
        console.log("=== EMPRESA #3 ===");
        const emp = await pool.query("SELECT id, nombre, verified, account_state, search_status, city, ciudad FROM empresas WHERE id = 3");
        console.log("Empresa:", emp.rows[0] || "NOT FOUND");

        const reqs = await pool.query("SELECT * FROM company_requirements WHERE company_id = 3");
        console.log("Requirements:", reqs.rows[0] || "NOT FOUND");

        const opTypes = await pool.query("SELECT value FROM company_req_operation_types WHERE company_id = 3");
        console.log("Req Op Types Bridge:", opTypes.rows.map(x => x.value));

        const licTypes = await pool.query("SELECT value FROM company_req_license_types WHERE company_id = 3");
        console.log("Req Lic Types Bridge:", licTypes.rows.map(x => x.value));

        console.log("\n=== DRIVER #7 ===");
        const drv = await pool.query("SELECT id, nombre, verified, status, search_status, availability, has_truck FROM drivers WHERE id = 7");
        console.log("Driver:", drv.rows[0] || "NOT FOUND");

        const drvOp = await pool.query("SELECT value FROM driver_operation_types WHERE driver_id = 7");
        console.log("Driver Op Types Bridge:", drvOp.rows.map(x => x.value));

        const drvLic = await pool.query("SELECT value FROM driver_license_types WHERE driver_id = 7");
        console.log("Driver Lic Types Bridge:", drvLic.rows.map(x => x.value));

    } catch (e) {
        console.error("Error", e);
    } finally {
        process.exit(0);
    }
}

run();

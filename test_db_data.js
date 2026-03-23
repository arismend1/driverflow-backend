const db = require('./db_adapter');

async function run() {
    try {
        console.log("=== EMPRESA #3 ===");
        const emp = await db.get("SELECT id, nombre, verified, account_state, search_status, city, ciudad FROM empresas WHERE id = 3");
        console.log("Empresa:", emp || "NOT FOUND");

        const reqs = await db.get("SELECT * FROM company_requirements WHERE company_id = 3");
        console.log("Requirements:", reqs || "NOT FOUND");

        const opTypes = await db.all("SELECT value FROM company_req_operation_types WHERE company_id = 3");
        console.log("Req Op Types Bridge:", opTypes.map(x => x.value));

        const licTypes = await db.all("SELECT value FROM company_req_license_types WHERE company_id = 3");
        console.log("Req Lic Types Bridge:", licTypes.map(x => x.value));

        console.log("\n=== DRIVER #7 ===");
        const drv = await db.get("SELECT id, nombre, verified, status, search_status, availability, has_truck FROM drivers WHERE id = 7");
        console.log("Driver:", drv || "NOT FOUND");

        const drvOp = await db.all("SELECT value FROM driver_operation_types WHERE driver_id = 7");
        console.log("Driver Op Types Bridge:", drvOp.map(x => x.value));

        const drvLic = await db.all("SELECT value FROM driver_license_types WHERE driver_id = 7");
        console.log("Driver Lic Types Bridge:", drvLic.map(x => x.value));

    } catch (e) {
        console.error("Error", e);
    } finally {
        process.exit(0);
    }
}

run();

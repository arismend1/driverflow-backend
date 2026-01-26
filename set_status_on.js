const Database = require("better-sqlite3");
const dbPath = process.env.DB_PATH || "driverflow.db";
const db = new Database(dbPath);

const companyId = Number(process.argv[2]);
const driverId = Number(process.argv[3]);

if (!companyId || !driverId) {
  console.log("USO: node set_status_on.js <companyId> <driverId>");
  process.exit(1);
}

db.prepare("UPDATE empresas SET search_status='ON' WHERE id=?").run(companyId);
db.prepare("UPDATE drivers  SET search_status='ON' WHERE id=?").run(driverId);

console.log("OK. Empresa ON:", companyId, "Chofer ON:", driverId);
db.close();
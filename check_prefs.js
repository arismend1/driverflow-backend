const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "driverflow.db");

const companyId = Number(process.argv[2] || 1);

const row = db.prepare(`
  SELECT * FROM company_match_prefs WHERE company_id=?
`).get(companyId);

console.log("PREFS:", row || "NO EXISTE (null)");

db.close();
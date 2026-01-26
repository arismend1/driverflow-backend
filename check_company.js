const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "driverflow.db");

const companyId = Number(process.argv[2] || 1);

const row = db.prepare(`
  SELECT id, nombre, search_status, account_state, is_blocked, creditos, tier
  FROM empresas
  WHERE id=?
`).get(companyId);

console.log("EMPRESA:", row);

db.close();
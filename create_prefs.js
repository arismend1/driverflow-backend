const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "driverflow.db");

const companyId = Number(process.argv[2] || 1);

// Inserta prefs mínimos si no existen
db.prepare(`
  INSERT INTO company_match_prefs (company_id, req_license, req_experience, created_at)
  VALUES (?, 'B', 'Any', datetime('now'))
`).run(companyId);

console.log("OK. company_match_prefs creado para company_id =", companyId);
db.close();
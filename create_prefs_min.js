const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "driverflow.db");

const companyId = Number(process.argv[2] || 1);

// Insertar prefs solo con columnas que EXISTEN en tu tabla
const sql = `
  INSERT OR REPLACE INTO company_match_prefs
  (company_id, req_license, req_experience, req_team_driving, req_start, req_restrictions)
  VALUES (?, ?, ?, ?, ?, ?)
`;

db.prepare(sql).run(
  companyId,
  "B",        // req_license
  "Any",      // req_experience
  "Either",   // req_team_driving
  "Flexible", // req_start
  "No"        // req_restrictions
);

console.log("✅ Prefs OK para company_id =", companyId);
db.close();
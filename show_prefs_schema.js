const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "driverflow.db");

const cols = db.prepare(`PRAGMA table_info(company_match_prefs)`).all();
console.log(cols);

db.close();
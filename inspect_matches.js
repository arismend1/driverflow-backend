const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "driverflow.db");

console.log("DB:", process.env.DB_PATH || "driverflow.db");

// listar tablas
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table'
  ORDER BY name
`).all();

console.log("TABLAS:");
for (const t of tables) console.log(" -", t.name);

// intenta detectar tablas candidatas
const candidates = tables.map(t=>t.name).filter(n =>
  n.includes("match") || n.includes("potential")
);

console.log("\nCANDIDATAS:", candidates);

db.close();
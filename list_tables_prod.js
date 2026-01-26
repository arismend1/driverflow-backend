const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = new Database(dbPath);

const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").all();
rows.forEach(row => console.log(row.name));

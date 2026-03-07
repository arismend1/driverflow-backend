const sqlite = require('better-sqlite3');
const db = new sqlite(process.env.DB_PATH || 'driverflow.db');
const tables = ['drivers', 'empresas'];
tables.forEach(table => {
    console.log(`--- Schema for ${table} ---`);
    try {
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        console.log(JSON.stringify(info, null, 2));
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }
});
db.close();

const Database = require('./node_modules/better-sqlite3');
const db = new Database('C:\\DriverFlow\\data\\driverflow_prod.db');

['drivers', 'empresas'].forEach(table => {
    console.log(`--- SQL for ${table} ---`);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(table);
    console.log(row ? row.sql : 'NOT FOUND');
});
db.close();

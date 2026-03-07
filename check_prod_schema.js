const Database = require('better-sqlite3');
const db = new Database('C:\\DriverFlow\\data\\driverflow_prod.db');

['drivers', 'empresas'].forEach(table => {
    console.log(`--- Schema for ${table} ---`);
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    info.forEach(col => {
        console.log(`${col.name} (${col.type}) ${col.notnull ? 'NOT NULL' : ''} ${col.dflt_value !== null ? 'DEFAULT ' + col.dflt_value : ''}`);
    });
});
db.close();

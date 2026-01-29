const Database = require('better-sqlite3');
const db = new Database('driverflow.db');

try {
    console.log('DRIVERS:', db.prepare('SELECT id FROM drivers LIMIT 5').all());
    console.log('COMPANIES:', db.prepare('SELECT id FROM empresas').all());
} catch (e) {
    console.error(e);
}

const Database = require('better-sqlite3');
const db = new Database('driverflow.db');
console.log('FK List tickets:', db.prepare('PRAGMA foreign_key_list(tickets)').all());

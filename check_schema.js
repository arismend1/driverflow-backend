const Database = require('better-sqlite3');
const db = new Database('c:/Users/dj23/Desktop/DriverFlow/driverflow-mvp/driverflow.db');
const schema = db.prepare("PRAGMA table_info(events_outbox)").all();
console.log('Events Outbox Columns:', schema.map(c => c.name));

const sqlite3 = require('better-sqlite3');
const db = sqlite3('driverflow.db');

try {
    const events = db.prepare('SELECT * FROM events_outbox').all();
    console.log('All Events:', events);

    // Check if table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables);

} catch (e) {
    console.error(e);
}

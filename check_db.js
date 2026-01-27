const Database = require('better-sqlite3');
const db = new Database('c:/Users/dj23/Desktop/DriverFlow/driverflow-mvp/driverflow.db');

console.log('Events Count:', db.prepare('SELECT count(*) as c FROM events_outbox').get().c);
console.log('Events By Status:', db.prepare('SELECT queue_status, count(*) as c FROM events_outbox GROUP BY queue_status').all());
console.log('Jobs Count:', db.prepare('SELECT count(*) as c FROM jobs_queue').get().c);
console.log('Jobs By Status:', db.prepare('SELECT status, count(*) as c FROM jobs_queue GROUP BY status').all());
const recentEvents = db.prepare('SELECT * FROM events_outbox ORDER BY id DESC LIMIT 5').all();
console.log('Recent Events:', JSON.stringify(recentEvents, null, 2));

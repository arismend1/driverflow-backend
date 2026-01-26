const Database = require("better-sqlite3");
const dbPath = process.env.DB_PATH;
if (!dbPath) { console.error("DB_PATH not set"); process.exit(1); }

const db = new Database(dbPath);

const rows = db.prepare(`
  SELECT id, event_name, request_id, process_status, send_attempts, last_error, created_at
  FROM events_outbox
  WHERE process_status='pending' AND event_name='invoice_generated'
  ORDER BY id ASC
`).all();

console.log(rows);
db.close();

const Database = require("better-sqlite3");

const db = new Database(process.env.DB_PATH);

const rows = db.prepare(`
  SELECT id,
         event_name,
         process_status,
         last_error,
         send_attempts,
         processed_at
  FROM events_outbox
  WHERE process_status IN ('failed','pending')
  ORDER BY id
`).all();

console.log(JSON.stringify(rows, null, 2));

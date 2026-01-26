const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error("DB_PATH not set");
  process.exit(1);
}

const db = new Database(dbPath);

const info = db.prepare(`
  UPDATE events_outbox
  SET
    process_status = 'ignored',
    processed_at = datetime('now'),
    last_error = 'Not an email event'
  WHERE process_status = 'pending'
    AND event_name = 'ticket_created'
`).run();

console.log({ updated: info.changes });

db.close();

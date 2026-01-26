const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error("❌ DB_PATH not set");
  process.exit(1);
}

const db = new Database(dbPath);

const rows = db
  .prepare(`
    SELECT process_status, COUNT(*) AS count
    FROM events_outbox
    GROUP BY process_status
  `)
  .all();

console.log(rows);

db.close();

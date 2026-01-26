const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH);

const now = new Date().toISOString().replace("T"," ").slice(0,19);

// Convertir invoice_paid pending/failed -> sent (ignored)
const r = db.prepare(`
  UPDATE events_outbox
  SET process_status='sent',
      processed_at=?,
      last_error='Non-email event (ignored)',
      send_attempts=0
  WHERE event_name='invoice_paid'
    AND process_status IN ('pending','failed')
`).run(now);

console.log({ invoice_paid_marked_sent: r.changes });

const counts = db.prepare(`
  SELECT process_status, COUNT(*) as count
  FROM events_outbox
  GROUP BY process_status
  ORDER BY process_status
`).all();
console.log(counts);

const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
if (!dbPath) { console.error("ERROR: DB_PATH no está seteado."); process.exit(1); }

const db = new Database(dbPath);

const info = db.prepare("PRAGMA table_info(events_outbox)").all();
const cols = info.map(c => ({ name: c.name, type: (c.type||'').toUpperCase(), notnull: c.notnull, dflt: c.dflt_value }));
const has = (c) => cols.some(x => x.name === c);
const col = (c) => cols.find(x => x.name === c);

const now = new Date().toISOString();
const req = col("request_id");

const payloadObj = {
  invoice_id: "INV-PAID-TEST-" + Date.now(),
  amount: 100,
  currency: "USD"
};

const row = {};
if (has("event_name")) row.event_name = "invoice_paid";
if (has("process_status")) row.process_status = "pending";
if (has("created_at")) row.created_at = now;
if (has("send_attempts")) row.send_attempts = 0;
if (has("last_error")) row.last_error = null;
if (has("processed_at")) row.processed_at = null;

if (has("company_id")) row.company_id = Number(process.env.TEST_COMPANY_ID || 1);
if (has("driver_id")) row.driver_id = null;

// request_id obligatorio
if (req && req.notnull === 1) {
  const v = Date.now();
  row.request_id = (req.type.includes("INT")) ? v : String(v);
}

const payloadJson = JSON.stringify(payloadObj);
if (has("payload")) row.payload = payloadJson;
else if (has("payload_json")) row.payload_json = payloadJson;
else if (has("event_payload")) row.event_payload = payloadJson;
else if (has("metadata")) row.metadata = payloadJson;

const keys = Object.keys(row);
const placeholders = keys.map(k => "@" + k).join(",");
const sql = `INSERT INTO events_outbox (${keys.join(",")}) VALUES (${placeholders})`;
db.prepare(sql).run(row);

const last = db.prepare("SELECT id,event_name,process_status,company_id,created_at FROM events_outbox ORDER BY id DESC LIMIT 1").get();
console.log("Inserted:", last);

db.close();

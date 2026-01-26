const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error("ERROR: DB_PATH no está seteado.");
  process.exit(1);
}

const db = new Database(dbPath);

function colInfo(name) {
  const cols = db.prepare(`PRAGMA table_info(events_outbox)`).all();
  const c = cols.find(x => x.name === name);
  return { cols, c };
}

const { cols, c: reqCol } = colInfo("request_id");
const has = (name) => cols.some(x => x.name === name);

const nowIso = new Date().toISOString();

const payloadObj = {
  invoice_id: "INV-TEST-" + Date.now(),
  amount: 100,
  currency: "USD",
  company_name: "Empresa Test Email",
  to_email: process.env.TEST_TO_EMAIL || "TU_EMAIL_REAL_AQUI"
};

const row = {};

// required-ish columns
if (has("event_name")) row.event_name = "invoice_generated";
if (has("process_status")) row.process_status = "pending";
if (has("created_at")) row.created_at = nowIso;

// optional tracking columns
if (has("send_attempts")) row.send_attempts = 0;
if (has("last_error")) row.last_error = null;
if (has("processed_at")) row.processed_at = null;

// ids
if (has("company_id")) row.company_id = Number(process.env.TEST_COMPANY_ID || 1);
if (has("driver_id")) row.driver_id = null;

// ? request_id auto-fix (CRÍTICO)
if (reqCol) {
  const isNotNull = reqCol.notnull === 1;
  if (isNotNull) {
    const t = (reqCol.type || "").toUpperCase();
    // INTEGER affinity vs TEXT (fallback TEXT)
    if (t.includes("INT")) row.request_id = Number(Date.now());
    else row.request_id = String(Date.now());
  } else {
    // nullable -> keep NULL unless you want a value
    row.request_id = null;
  }
}

// ? store metadata/payload
const payloadJson = JSON.stringify(payloadObj);
if (has("metadata")) row.metadata = payloadJson;
else if (has("payload")) row.payload = payloadJson;
else if (has("payload_json")) row.payload_json = payloadJson;
else if (has("event_payload")) row.event_payload = payloadJson;

const keys = Object.keys(row);
if (keys.length < 3) {
  console.error("ERROR: No pude armar el INSERT. Columnas detectadas:", cols.map(c => c.name));
  process.exit(1);
}

// quote columns safely
const colList = keys.map(k => `"${k}"`).join(", ");
const placeholders = keys.map(k => `@${k}`).join(", ");
const sql = `INSERT INTO events_outbox (${colList}) VALUES (${placeholders})`;

db.prepare(sql).run(row);

const last = db.prepare(`
  SELECT id, event_name, process_status, created_at, request_id
  FROM events_outbox
  ORDER BY id DESC LIMIT 1
`).get();

console.log("? Inserted Record:", last);
db.close();
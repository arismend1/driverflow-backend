const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
if (!dbPath) { console.error("ERROR: DB_PATH no está seteado."); process.exit(1); }

const companyId = Number(process.env.TEST_COMPANY_ID || 2035);
const driverId  = Number(process.env.TEST_DRIVER_ID  || 890);
const matchId   = Number(process.env.TEST_MATCH_ID   || 0);

if (!companyId || !driverId || !matchId) {
  console.error("ERROR: Faltan IDs. Setea TEST_COMPANY_ID, TEST_DRIVER_ID, TEST_MATCH_ID.");
  process.exit(1);
}

const db = new Database(dbPath);

const cols = db.prepare("PRAGMA table_info(events_outbox)").all();
const colNames = cols.map(c => c.name);
const has = (c) => colNames.includes(c);

const now = new Date().toISOString();
const requestId = Date.now(); // sirve como entero único

const payloadObj = {
  match_id: matchId,
  company_id: companyId,
  driver_id: driverId
};

const row = {};
if (has("event_name")) row.event_name = "match_confirmed";
if (has("process_status")) row.process_status = "pending";
if (has("created_at")) row.created_at = now;
if (has("send_attempts")) row.send_attempts = 0;
if (has("last_error")) row.last_error = null;
if (has("processed_at")) row.processed_at = null;

if (has("company_id")) row.company_id = companyId;
if (has("driver_id")) row.driver_id = driverId;

const payloadJson = JSON.stringify(payloadObj);

// metadata/payload segun exista
if (has("metadata")) row.metadata = payloadJson;
else if (has("payload")) row.payload = payloadJson;
else if (has("payload_json")) row.payload_json = payloadJson;
else if (has("event_payload")) row.event_payload = payloadJson;

// request_id si existe
if (has("request_id")) {
  const t = (cols.find(c => c.name === "request_id")?.type || "").toUpperCase();
  row.request_id = t.includes("INT") ? requestId : String(requestId);
}

const keys = Object.keys(row);
const placeholders = keys.map(k => "@" + k).join(",");
const sql = `INSERT INTO events_outbox (${keys.join(",")}) VALUES (${placeholders})`;

db.prepare(sql).run(row);

const last = db.prepare("SELECT id,event_name,process_status,company_id,driver_id,created_at FROM events_outbox ORDER BY id DESC LIMIT 1").get();
console.log("Inserted:", last);

db.close();

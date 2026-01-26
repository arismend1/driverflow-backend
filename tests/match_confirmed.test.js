const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");

function makeTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "driverflow-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);

  // Schema mínimo requerido por process_outbox_emails.js
  db.exec(`
    CREATE TABLE empresas (
      id INTEGER PRIMARY KEY,
      nombre TEXT NOT NULL,
      contacto TEXT NOT NULL
    );

    CREATE TABLE drivers (
      id INTEGER PRIMARY KEY,
      nombre TEXT NOT NULL,
      contacto TEXT NOT NULL
    );

    CREATE TABLE events_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      process_status TEXT NOT NULL DEFAULT 'pending',
      company_id INTEGER,
      driver_id INTEGER,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      last_error TEXT,
      send_attempts INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );
  `);

  // Seed empresa + chofer
  db.prepare("INSERT INTO empresas (id, nombre, contacto) VALUES (?,?,?)")
    .run(2035, "Empresa Test", "empresa_test@demo.com");

  db.prepare("INSERT INTO drivers (id, nombre, contacto) VALUES (?,?,?)")
    .run(890, "Chofer Test", "chofer_test@demo.com");

  // Evento match_confirmed pending
  db.prepare(`
    INSERT INTO events_outbox (event_name, process_status, company_id, driver_id, created_at, metadata)
    VALUES ('match_confirmed','pending',?,?,?,?)
  `).run(2035, 890, new Date().toISOString(), JSON.stringify({ match_id: 28 }));

  db.close();
  return { dbPath, tmpDir };
}

test("match_confirmed must send 2 emails and never fall into no-email logic", () => {
  const { dbPath } = makeTempDb();

  // 1) Portable path resolution (Processor is in Parent Root)
  const processorPath = path.resolve(__dirname, "..", "process_outbox_emails.js");

  // Validate existence
  if (!fs.existsSync(processorPath)) {
    throw new Error("process_outbox_emails.js not found at: " + processorPath);
  }

  // 2) Exec using current Node path + DRY_RUN
  const result = spawnSync(
    process.execPath,
    [processorPath],
    {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        DRY_RUN: "1",
        SENDGRID_API_KEY: "SG.DUMMY_KEY_FOR_TESTING_PURPOSES_" + "X".repeat(30),
        SENDGRID_FROM: "no-reply@driverflow.app",
        SENDGRID_FROM_NAME: "DriverFlow"
      },
      encoding: "utf8"
    }
  );

  const out = (result.stdout || "") + "\n" + (result.stderr || "");

  // 3) Exit code 0
  assert.equal(result.status, 0, `Process exited with ${result.status}. Output:\n${out}`);

  // 4) Assertions on output
  // Must NOT find '0 pending events' (means test setup failed)
  assert.doesNotMatch(out, /Found 0 pending events/, "Test Error: No pending events found by processor.");

  // Must find evidence of 2 emails sent
  assert.match(out, /Sent successfully \(2 emails\)/, "Expected 'Sent successfully (2 emails)' in output.");

  // Must NOT fall into 'no email logic'
  assert.doesNotMatch(out, /Marked sent \(no email logic\)/, "Forbidden: 'no email logic' triggered for match_confirmed.");

  // 5) Verify DB state
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(`
    SELECT process_status, last_error
    FROM events_outbox
    WHERE event_name='match_confirmed'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  db.close();

  assert.equal(row.process_status, "sent", "DB Record status should be 'sent'.");
  assert.equal(row.last_error, null, "DB Record last_error should be null.");
});
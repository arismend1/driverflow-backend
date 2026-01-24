const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || "driverflow.db";
const db = new Database(DB_PATH);

// Config
const DRY_RUN = process.env.DRY_RUN === "1";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM || process.env.EMAIL_FROM_BILLING || "";
const FROM_NAME = process.env.SENDGRID_FROM_NAME || "DriverFlow";

// Logging
console.log("--- Email Processor Started ---");
console.log(`DB_PATH:   ${DB_PATH}`);
console.log(`DRY_RUN:   ${DRY_RUN}`);
console.log(`SENDER:    "${FROM_NAME}" <${FROM_EMAIL || "MISSING"}>`);
console.log(`KEY LEN:   ${SENDGRID_KEY.length}`);

// Strict validation for live sends
if (!DRY_RUN) {
  if (!FROM_EMAIL) {
    console.error("❌ FATAL: Missing sender. Set SENDGRID_FROM or EMAIL_FROM_BILLING.");
    process.exit(1);
  }
  // SendGrid keys are typically long; < 50 is almost always wrong
  if (SENDGRID_KEY.length < 50) {
    console.error("❌ FATAL: Missing/invalid SENDGRID_API_KEY (too short).");
    process.exit(1);
  }
}

function nowSql() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function sendEmailSendGrid(to, subject, textBody) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] would send => to=${to} subject="${subject}"`);
    return { ok: true, status: 202 };
  }

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    content: [{ type: "text/plain", value: textBody }]
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    const lower = txt.toLowerCase();

    // Critical guards
    if (res.status === 401) throw new Error(`CRITICAL_AUTH_FAIL: ${txt}`);
    if (res.status === 403 && lower.includes("sender identity")) throw new Error(`SENDER_IDENTITY_FAIL: ${txt}`);

    // Retryable
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const e = new Error(`RETRYABLE_SENDGRID_${res.status}: ${txt}`);
      e.retryable = true;
      return Promise.reject(e);
    }

    // Non-retryable
    throw new Error(`SendGrid Error ${res.status}: ${txt}`);
  }

  return res;
}

// Statements (assume these columns exist in your schema)
const sqlMarkSent = db.prepare(`
  UPDATE events_outbox
  SET process_status='sent', processed_at=?, last_error=NULL, send_attempts=send_attempts+1
  WHERE id=?
`);
const sqlMarkFailed = db.prepare(`
  UPDATE events_outbox
  SET process_status='failed', processed_at=?, last_error=?, send_attempts=send_attempts+1
  WHERE id=?
`);
const sqlRequeue = db.prepare(`
  UPDATE events_outbox
  SET process_status='pending', processed_at=?, last_error=?, send_attempts=send_attempts+1
  WHERE id=?
`);

// Main
async function run() {
  const events = db.prepare(`
    SELECT * FROM events_outbox
    WHERE process_status='pending'
    ORDER BY id ASC
    LIMIT 50
  `).all();

  console.log(`Found ${events.length} pending events.`);
  if (events.length === 0) return;

  for (const ev of events) {
    console.log(`\nProcessing Event #${ev.id} [${ev.event_name}]`);

    // Parse metadata safely
    let meta = {};
    try {
      meta = JSON.parse(ev.metadata || "{}");
    } catch {
      sqlMarkFailed.run(nowSql(), "Invalid JSON in metadata", ev.id);
      console.log("❌ Failed: invalid metadata JSON");
      continue;
    }

    // List of emails to send for this event
    let messages = []; // { to, subject, body }

    // --- 1. Company Events ---
    if (["company_registered", "invoice_generated", "invoice_paid", "potential_match_company"].includes(ev.event_name)) {
      if (!ev.company_id) {
        sqlMarkFailed.run(nowSql(), "Missing company_id", ev.id);
        console.log("❌ Failed: Missing company_id");
        continue;
      }
      const co = db.prepare("SELECT nombre, contacto FROM empresas WHERE id=?").get(ev.company_id);
      if (!co) {
        sqlMarkFailed.run(nowSql(), "Company not found", ev.id);
        console.log("❌ Failed: Company not found");
        continue;
      }

      // Priority: payload.to_email > empresa.contacto
      const rawPayload = ev.payload || ev.payload_json || ev.event_payload || ev.metadata || "{}";
      let p = {};
      try { p = JSON.parse(rawPayload); } catch (_) { p = {}; }

      const to = (p && p.to_email && String(p.to_email).includes("@"))
        ? String(p.to_email).trim()
        : co.contacto;

      let subject = "";
      let body = "";

      if (ev.event_name === "company_registered") {
        subject = "Welcome to DriverFlow";
        body = `Hola ${co.nombre},\n\nTu empresa fue registrada. Cuando estés listo, activa la búsqueda.\n`;
      }
      else if (ev.event_name === "invoice_generated") {
        subject = "Invoice Generated";
        body = `Hola ${co.nombre},\n\nNueva factura disponible.\nInvoice: ${meta.invoice_id || "(sin id)"}\n`;
      }
      else if (ev.event_name === "invoice_paid") {
        subject = "Payment Received";
        body = `Hola ${co.nombre},\n\nPago recibido.\nInvoice: ${meta.invoice_id || "(sin id)"}\n`;
      }
      else if (ev.event_name === "potential_match_company") {
        subject = "New Driver Match";
        body = `Hola ${co.nombre},\n\nTienes un nuevo match. Entra al dashboard para verlo.\n`;
      }

      messages.push({ to, subject, body });
    }

    // --- 2. Driver Events ---
    else if (["potential_match_driver"].includes(ev.event_name)) {
      if (!ev.driver_id) {
        sqlMarkFailed.run(nowSql(), "Missing driver_id", ev.id);
        console.log("❌ Failed: Missing driver_id");
        continue;
      }
      const dr = db.prepare("SELECT nombre, contacto FROM drivers WHERE id=?").get(ev.driver_id);
      if (!dr) {
        sqlMarkFailed.run(nowSql(), "Driver not found", ev.id);
        console.log("❌ Failed: Driver not found");
        continue;
      }

      messages.push({
        to: dr.contacto,
        subject: "New Job Match",
        body: `Hola ${dr.nombre},\n\nUna empresa hizo match con tu perfil.\n`
      });
    }

    // --- 3. Match Confirmed (Dual Send) ---
    else if (ev.event_name === 'match_confirmed') {
      if (!ev.company_id || !ev.driver_id) {
        sqlMarkFailed.run(nowSql(), "Missing company_id or driver_id", ev.id);
        console.log("❌ Failed: Missing IDs for match");
        continue;
      }

      const co = db.prepare("SELECT nombre, contacto FROM empresas WHERE id=?").get(ev.company_id);
      const dr = db.prepare("SELECT nombre, contacto FROM drivers WHERE id=?").get(ev.driver_id);

      if (!co || !dr) {
        sqlMarkFailed.run(nowSql(), "Company or Driver not found in DB", ev.id);
        console.log("❌ Failed: One of the parties not found");
        continue;
      }

      // Email 1: Company
      messages.push({
        to: co.contacto,
        subject: "Match Confirmed",
        body: `Hola ${co.nombre},\n\nSe ha confirmado un match. Se ha creado un ticket. Paga para desbloquear contacto.\n`
      });

      // Email 2: Driver
      messages.push({
        to: dr.contacto,
        subject: "Match Confirmed",
        body: `Hola ${dr.nombre},\n\nUna empresa ha aceptado tu solicitud. Pronto se pondran en contacto contigo.\n`
      });
      // Important: continue fallback logic down below to send
    }

    // --- 4. Password Reset ---
    else if (ev.event_name === 'password_reset_sent') {
      const rawPayload = ev.payload || ev.payload_json || ev.event_payload || ev.metadata || "{}";
      let p = {};
      try { p = JSON.parse(rawPayload); } catch (_) { p = {}; }

      if (!p.to_email || !p.temp_password) {
        sqlMarkFailed.run(nowSql(), "Missing email or temp_password", ev.id);
        console.log("❌ Failed: Missing payload data for reset");
        continue;
      }

      messages.push({
        to: p.to_email,
        subject: "DriverFlow: Recuperación de Contraseña",
        body: `Hola,\n\nHas solicitado restablecer tu contraseña.\n\nTu nueva contraseña temporal es: ${p.temp_password}\n\nPor favor, inicia sesión y cámbiala lo antes posible.\n`
      });
    }


    // --- Execute Sending ---

    if (messages.length === 0) {
      // SAFETY GUARD: match_confirmed must NEVER fall here (unless already failed/continued)
      if (ev.event_name === 'match_confirmed') {
        sqlMarkFailed.run(nowSql(), "Logic Error: match_confirmed with 0 messages", ev.id);
        console.log("❌ Failed: Logic Error (0 messages for match_confirmed)");
        continue;
      }

      // No email logic => clean mark as sent
      db.prepare(`
        UPDATE events_outbox
        SET process_status='sent', processed_at=?, last_error=NULL
        WHERE id=?
      `).run(nowSql(), ev.id);
      console.log("✅ Marked sent (no email logic).");
      continue;
    }

    // Send with retries
    const tries = 3;
    let done = false;

    for (let i = 1; i <= tries; i++) {
      try {
        // Send all messages for this event (Atomic-ish)
        for (const msg of messages) {
          await sendEmailSendGrid(msg.to, msg.subject, msg.body);
        }

        sqlMarkSent.run(nowSql(), ev.id);
        console.log(`✅ Sent successfully (${messages.length} emails).`);
        done = true;
        break;

      } catch (e) {
        const msg = String(e.message || e);

        // Critical config => abort batch immediately
        if (msg.includes("CRITICAL_AUTH_FAIL") || msg.includes("SENDER_IDENTITY_FAIL")) {
          sqlMarkFailed.run(nowSql(), msg, ev.id);
          console.error("⛔ FATAL CONFIG ERROR. Aborting batch.");
          process.exitCode = 1;
          return;
        }

        // Retryable?
        const retryable = e.retryable === true || msg.startsWith("RETRYABLE_SENDGRID_");
        if (retryable && i < tries) {
          sqlRequeue.run(nowSql(), msg, ev.id);
          console.log(`⚠️ Retryable error. Requeued (try ${i}/${tries}).`);
          break; // requeued => stop trying in this run
        }

        // Non-retryable or maxed out
        sqlMarkFailed.run(nowSql(), msg, ev.id);
        console.log("❌ Failed (non-retryable or max attempts).");
        done = true;
        break;
      }
    }

    if (!done) {
      // Should be covered by break above, but just in case
    }
  }
}

run()
  .catch(e => {
    console.error("Global Error:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    try { db.close(); } catch { }
  });
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || "driverflow.db";
const db = new Database(DB_PATH);

// Config
const DRY_RUN = process.env.DRY_RUN === "1";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@driverflow.app";
const FROM_NAME = "DriverFlow";
const API_URL = process.env.API_URL || "https://driverflow-backend.onrender.com";

// Logging
console.log("--- Email Processor Started ---");
console.log(`DB_PATH:   ${DB_PATH}`);
console.log(`DRY_RUN:   ${DRY_RUN}`);

// Strict validation for live sends
if (!DRY_RUN) {
  if (SENDGRID_KEY.length < 10) { // Relaxed length check mostly for checking existence
    console.error("❌ FATAL: Missing/invalid SENDGRID_API_KEY.");
    process.exit(1);
  }
  if (!FROM_EMAIL.includes("@")) {
    console.error(`❌ FATAL: Invalid FROM_EMAIL: '${FROM_EMAIL}'`);
    process.exit(1);
  }
  if (FROM_EMAIL !== "no-reply@driverflow.app") {
    console.error(`❌ FATAL: FROM_EMAIL must be EXACTLY 'no-reply@driverflow.app'. Got: '${FROM_EMAIL}'`);
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
    content: [{ type: "text/plain", value: textBody }],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false }
    }
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
    throw new Error(`SendGrid Error ${res.status}: ${txt}`);
  }

  return res;
}

const sqlMarkSent = db.prepare(`UPDATE events_outbox SET process_status='sent', processed_at=?, last_error=NULL, send_attempts=send_attempts+1 WHERE id=?`);
const sqlMarkFailed = db.prepare(`UPDATE events_outbox SET process_status='failed', processed_at=?, last_error=?, send_attempts=send_attempts+1 WHERE id=?`);

async function runOnce() {
  const events = db.prepare(`SELECT * FROM events_outbox WHERE process_status='pending' ORDER BY id ASC LIMIT 50`).all();
  if (events.length > 0) console.log(`Processing ${events.length} events...`);

  for (const ev of events) {
    let meta = {};
    try { meta = JSON.parse(ev.metadata || "{}"); } catch { }

    let messages = [];

    // --- 4. Verification Email ---
    if (ev.event_name === 'verification_email') {
      const { token, email, name, user_type } = meta;
      if (token && email) {
        messages.push({
          to: email,
          subject: "Verifica tu cuenta - DriverFlow",
          body: `Hola ${name || 'Usuario'},\n\nGracias por registrarte.\n\nActiva tu cuenta aquí:\n${API_URL}/verify-email?token=${token}\n\nO usa el código: ${token}\n(Deep Link: driverflow://verify-email?token=${token})`
        });
      }
    }

    // --- 5. Recovery Email ---
    else if (ev.event_name === 'recovery_email') {
      const { token, email, name } = meta;
      if (token && email) {
        messages.push({
          to: email,
          subject: "Restablecer Contraseña - DriverFlow",
          body: `Hola ${name || 'Usuario'},\n\nSolicitaste recuperar tu contraseña.\n\nHaz clic aquí:\n${API_URL}/reset-password-web?token=${token}\n\n(Deep Link: driverflow://reset-password?token=${token})`
        });
      }
    }

    // --- Sending ---
    if (messages.length === 0) {
      if (!['verification_email', 'recovery_email'].includes(ev.event_name)) {
        // Skip other events silently or implement them
      } else {
        sqlMarkFailed.run(nowSql(), "No info to send", ev.id);
      }
      continue;
    }

    try {
      for (const msg of messages) {
        await sendEmailSendGrid(msg.to, msg.subject, msg.body);
      }
      sqlMarkSent.run(nowSql(), ev.id);
      console.log(`✅ Sent event #${ev.id}`);
    } catch (e) {
      console.error(`❌ Failed event #${ev.id}:`, e.message);
      sqlMarkFailed.run(nowSql(), e.message, ev.id);
    }
  }
}

// Poll Loop
// Poll Loop
const POLL_MS = 10000;
async function startWorker() {
  console.log(`Worker polling every ${POLL_MS}ms...`);
  while (true) {
    try { await runOnce(); } catch (e) { console.error("Loop Error:", e); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Export for usage in server.js
module.exports = { startWorker };

// Auto-start if run directly (e.g. node process_outbox_emails.js)
if (require.main === module) {
  startWorker();
}
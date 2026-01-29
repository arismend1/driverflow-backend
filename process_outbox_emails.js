const db = require('./db_adapter');
// SQLite removed
// const DB_PATH = (process.env.DB_PATH || "driverflow.db").trim();

// Config
const DRY_RUN = process.env.DRY_RUN === "1";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = (process.env.FROM_EMAIL || "no-reply@driverflow.app").trim();
const FROM_NAME = "DriverFlow";
const API_URL = process.env.API_URL || "https://driverflow-backend.onrender.com";

// Observability
const logger = require('./logger');
const metrics = require('./metrics');

// Logging - STRUCTURED
logger.info("--- Email Processor Started ---", { event: 'worker_start', service: 'worker' });
// logger.info("DB Config", { event: 'worker_config', db_path: DB_PATH, dry_run: DRY_RUN, service: 'worker' });

// Strict validation for live sends
if (!DRY_RUN) {
  if (SENDGRID_KEY.length < 10) {
    logger.error("FATAL: Missing/invalid SENDGRID_API_KEY", { event: 'worker_config_error' });
    process.exit(1);
  }
  if (!FROM_EMAIL.includes("@")) {
    logger.error(`FATAL: Invalid FROM_EMAIL: '${FROM_EMAIL}'`, { event: 'worker_config_error' });
    process.exit(1);
  }
  if (FROM_EMAIL !== "no-reply@driverflow.app") {
    logger.error(`FATAL: FROM_EMAIL must be EXACTLY 'no-reply@driverflow.app'. Got: '${FROM_EMAIL}'`, { event: 'worker_config_error' });
    process.exit(1);
  }
}

// 1. Ensure DB Sanity (Req D.1) - ASYNC
(async () => {
  try {
    const check = await db.get("SELECT count(*) as c FROM events_outbox");
    logger.info("DB Check OK", { event: 'db_open_ok', count: check.c });
  } catch (e) {
    logger.error("FATAL: events_outbox missing or DB invalid", { event: 'db_open_fail', err: e });
    process.exit(1);
  }
})();

function nowSql() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function sendEmailSendGrid(to, subject, textBody) {
  if (DRY_RUN) {
    logger.info("DRY RUN EMAIL", { event: 'email_dry_run', to, subject, service: 'worker' });
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

// Prepared statements replacement
// const sqlMarkSent = db.prepare(`UPDATE events_outbox SET process_status='sent', processed_at=?, last_error=NULL, send_attempts=send_attempts+1 WHERE id=?`);
// const sqlMarkFailed = db.prepare(`UPDATE events_outbox SET process_status='failed', processed_at=?, last_error=?, send_attempts=send_attempts+1 WHERE id=?`);

async function markSent(id) {
  await db.run(`UPDATE events_outbox SET process_status='sent', processed_at=?, last_error=NULL, send_attempts=send_attempts+1 WHERE id=?`, nowSql(), id);
}

async function markFailed(id, error) {
  await db.run(`UPDATE events_outbox SET process_status='failed', processed_at=?, last_error=?, send_attempts=send_attempts+1 WHERE id=?`, nowSql(), error, id);
}

async function runOnce() {
  const events = await db.all(`SELECT * FROM events_outbox WHERE process_status='pending' ORDER BY id ASC LIMIT 50`);

  if (events.length > 0) logger.info(`Processing ${events.length} events...`, { event: 'worker_poll_batch', count: events.length, service: 'worker' });

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
        await markFailed(ev.id, "No info to send");
      }
      continue;
    }

    try {
      for (const msg of messages) {
        await sendEmailSendGrid(msg.to, msg.subject, msg.body);
      }
      await markSent(ev.id);

      logger.info(`Email Sent`, { event: 'email_sent', outbox_id: ev.id, event_name: ev.event_name, service: 'worker' });
      metrics.inc('emails_sent_total');

    } catch (e) {
      logger.error(`Email Failed`, { event: 'email_failed', outbox_id: ev.id, err: e, service: 'worker' });
      await markFailed(ev.id, e.message);
      metrics.inc('emails_failed_total');
    }
  }
}

// Poll Loop
const POLL_MS = 30000;

async function startWorker() {
  logger.info(`Worker polling started`, { event: 'worker_loop_start', interval_ms: POLL_MS });

  while (true) {
    try {
      // 1. Heartbeat (Req D.3)
      const now = new Date().toISOString();
      await db.run(`
            INSERT INTO worker_heartbeat (worker_name, last_seen, status, metadata)
            VALUES ('email_worker', ?, 'running', ?)
            ON CONFLICT(worker_name) DO UPDATE SET last_seen=excluded.last_seen, status='running'
        `, now, JSON.stringify({ pid: process.pid }));

      // 2. Poll metrics
      const pendingRes = await db.get("SELECT count(*) as c FROM events_outbox WHERE process_status='pending'");
      const pending = pendingRes ? pendingRes.c : 0;

      logger.info('Worker Poll', { event: 'worker_poll', pending_count: pending, service: 'worker' });

      // 3. Process
      await runOnce();

    } catch (e) {
      logger.error("Loop Error", { event: 'worker_loop_error', err: e, service: 'worker' });
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Export for usage in server.js
module.exports = { startWorker };

// Auto-start if run directly (e.g. node process_outbox_emails.js)
if (require.main === module) {
  startWorker();
}
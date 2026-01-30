// REDIRECT: Legacy Entry Point for Render
// Even though we switched to worker_queue.js, Render configuration might still point here.
// This file ensures the worker starts correctly without needing a manual config change.

console.log("➡️  Redirecting process_outbox_emails.js to worker_queue.js...");

const { startQueueWorker } = require('./worker_queue');
const { validateEnv } = require('./env_guard');

// Validate Env (as worker)
validateEnv({ role: 'worker' });

// Start the real worker
startQueueWorker().catch(err => {
    console.error('FATAL: Worker Redirect Failed', err);
    process.exit(1);
});

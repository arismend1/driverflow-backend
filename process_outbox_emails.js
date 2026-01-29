// process_outbox_emails.js is DEPRECATED in favor of internal worker_queue.js
// This file is kept as a stub to prevent start:worker errors if still configured in Render
console.log("Legacy Worker process_outbox_emails.js is DISABLED. Use server.js internal worker.");
setInterval(() => {
  // Keep alive but do nothing to avoid crash loops if platform expects a process
}, 60000);
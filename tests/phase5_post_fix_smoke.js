const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const path = require('path');
const { execSync } = require('child_process');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../driverflow.db');
const db = new Database(DB_PATH);

test('Phase 5 Post-Fix Smoke: Double Email & Bridge', async (t) => {
    // Setup
    const now = new Date().toISOString();
    const uniqueEmail = `fix_test_${Date.now()}@example.com`;
    const eventKey = `fix_event_${Date.now()}`;

    // 1. Insert Event into Outbox directly (Simulate App Logic)
    console.log('1. Inserting event into events_outbox');
    const insert = db.prepare(`
        INSERT INTO events_outbox (event_name, created_at, metadata, event_key, queue_status)
        VALUES (?, ?, ?, ?, 'pending')
    `).run('verification_email', now, JSON.stringify({ email: uniqueEmail, token: '123456' }), eventKey);

    const eventId = insert.lastInsertRowid;
    assert.ok(eventId, 'Event created');

    // 2. Trigger Bridge (Manually run worker snippet or just wait if worker running?)
    // Since we are testing logic, we can manually import and run `bridgeOutbox` function from worker_queue.js
    // BUT worker_queue.js might be running in background if server is up?
    // Let's assume we run the bridge function via require to test logic locally.

    const worker = require('../worker_queue');
    console.log('2. Running bridgeOutbox()');
    worker.bridgeOutbox(); // Should move event to queue

    // 3. Verify Event updated in Outbox
    const updatedEvent = db.prepare('SELECT * FROM events_outbox WHERE id = ?').get(eventId);
    assert.strictEqual(updatedEvent.queue_status, 'queued', 'Event status should be queued');
    assert.ok(updatedEvent.queued_at, 'Event queued_at should be set');

    // 4. Verify Job Created in Jobs Queue
    const job = db.prepare('SELECT * FROM jobs_queue WHERE source_event_id = ?').get(eventId);
    assert.ok(job, 'Job should exist in jobs_queue');
    assert.strictEqual(job.job_type, 'send_email', 'Job type should be send_email');
    assert.strictEqual(JSON.parse(job.payload_json).email, uniqueEmail, 'Email in payload matches');

    // 5. Verify Uniqueness (Run Bridge Again)
    console.log('3. Running bridgeOutbox() again (Attempt Double Bridge)');
    // Reset status to pending to simulate race? No, logic prevents it. 
    // Logic: bridge selects 'pending'. If it's already 'queued', it won't be selected. 
    // TEST: Manually set status back to pending but leave job.

    db.prepare("UPDATE events_outbox SET queue_status='pending' WHERE id=?").run(eventId);

    // Run bridge again
    worker.bridgeOutbox();

    // Check jobs count
    const jobsCount = db.prepare('SELECT count(*) as c FROM jobs_queue WHERE source_event_id = ?').get(eventId);
    assert.strictEqual(jobsCount.c, 1, 'Should NOT create duplicate job even if event is pending again (Unique Constraint)');

    console.log('PASS: Bridge logic is atomic and idempotent.');
});

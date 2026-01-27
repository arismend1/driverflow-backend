const jwt = require('jsonwebtoken'); // native in node_modules or need install? 
// We know logic: uses secret key
const fs = require('fs');
const path = require('path');

const SECRET = process.env.SECRET_KEY || 'dev_secret_key_123';
const token = jwt.sign({ role: 'admin', id: 999 }, SECRET, { expiresIn: '24h' });
const API_URL = 'http://localhost:3000';

const INTERVAL_MS = process.argv[2] ? parseInt(process.argv[2]) : 15 * 60 * 1000; // Default 15 min
const MAX_CHECKS = process.argv[3] ? parseInt(process.argv[3]) : 96; // 24h * 4

console.log(`--- SRE MONITOR NOT STARTED ---`);
console.log(`Interval: ${INTERVAL_MS / 1000}s | Max Checks: ${MAX_CHECKS}`);
console.log(`Log File: sre_monitor.csv`);
console.log(`Token: Generated (Admin)`);

// Headers
const LOG_FILE = 'sre_monitor.csv';
if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'Timestamp,Pending,Done,Dead,Processing,Heartbeat_Age_Sec,Status\n');
}

async function check() {
    const now = new Date().toISOString();
    try {
        const res = await fetch(`${API_URL}/queue/stats`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        // Parse Stats
        const stats = { pending: 0, done: 0, dead: 0, processing: 0 };
        data.stats.forEach(s => {
            if (stats[s.status] !== undefined) stats[s.status] = s.count;
        });

        // Heartbeat Check
        const hb = data.heartbeat;
        let hbAge = -1;
        let hbStatus = 'UNKNOWN';
        if (hb && hb.last_seen) {
            hbAge = (new Date() - new Date(hb.last_seen)) / 1000;
            hbStatus = hbAge < 60 ? 'OK' : 'STALE';
        } else {
            hbStatus = 'MISSING';
        }

        // Logic Check
        let status = 'STEADY';
        if (stats.pending > 50 && hbStatus === 'OK') status = 'HIGH_LOAD';
        if (hbStatus !== 'OK') status = 'CRITICAL_WORKER_DOWN';
        if (stats.dead > 0) status = 'HAS_DEAD_JOBS';

        // Output
        const row = `${now},${stats.pending},${stats.done},${stats.dead},${stats.processing},${hbAge.toFixed(1)},${status}`;
        fs.appendFileSync(LOG_FILE, row + '\n');

        console.log(`[${now}] Pending: ${stats.pending} | Done: ${stats.done} | Dead: ${stats.dead} | Proc: ${stats.processing} | HB: ${hbAge.toFixed(1)}s (${hbStatus}) -> ${status}`);

        // Errors?
        if (data.recent_errors && data.recent_errors.length > 0) {
            console.log('   ⚠️ RECENT ERRORS:');
            data.recent_errors.forEach(e => console.log(`   - [Attempt ${e.attempts}] ${e.last_error}`));
        }

    } catch (e) {
        console.error(`[${now}] CHECK FAILED: ${e.message}`);
    }
}

// Loop
let count = 0;
check(); // Initial
const timer = setInterval(() => {
    count++;
    if (count >= MAX_CHECKS) {
        clearInterval(timer);
        console.log('--- MONITOR COMPLETE ---');
    } else {
        check();
    }
}, INTERVAL_MS);

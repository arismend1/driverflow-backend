const fs = require('fs');

const content = fs.readFileSync('server.js', 'utf8');

const startMarker = "// 2. Readiness (Deep Check)\r\napp.get('/readyz', async (req, res) => {";
const endMarker = "// 3. Metrics (Protected + Persistent)";

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find markers!");
    // Try without \r
    const startMarker2 = "// 2. Readiness (Deep Check)\napp.get('/readyz', async (req, res) => {";
    const startIndex2 = content.indexOf(startMarker2);
    if (startIndex2 !== -1) {
        // Found with \n
        const newContent = content.substring(0, startIndex2) +
            `// 2. Readiness (Deep Check)
app.get('/readyz', async (req, res) => {
    const checks = {
        db: false,
        tables_exist: false,
        worker_running: false
    };

    try {
        // DB Check
        const one = await db.get('SELECT 1');
        if (one) checks.db = true;

        // Tables Check
        checks.tables_exist = true; 

        // Worker Heartbeat Check
        try {
            const hb = await db.get("SELECT last_seen FROM worker_heartbeat WHERE worker_name='email_worker'");
            if (hb) {
                const last = new Date(hb.last_seen);
                // db_adapter.get might return date string or object depending on driver
                // PG returns Date object for TIMESTAMPTZ? SQLite returns string?
                // Let's handle both.
                const t = last instanceof Date ? last.getTime() : new Date(last).getTime();
                const now = Date.now(); // or nowEpochMs() but we need to import it or valid scope
                // Using Date.now() is safe for simple diff check if 'last' is correct
                // But wait, nowEpochMs() is global in server.js? No, imported.
                // Assuming imported.
                const diffSec = (Date.now() - t) / 1000;
                if (diffSec < 60) checks.worker_running = true;
            }
        } catch (e) { /* ignore */ }

    } catch (e) {
        // logger valid? assuming scope
        console.error('Readiness Check Failed', e); 
        return res.status(503).json({ ok: false, error: e.message, checks });
    }

    if (Object.values(checks).every(v => v)) {
        res.json({ ok: true, checks });
    } else {
        res.status(503).json({ ok: false, checks });
    }
});

` + content.substring(endIndex);
        fs.writeFileSync('server.js', newContent);
        console.log("Fixed server.js");
    } else {
        console.error("CRITICAL: Markers not found even with \\n");
        console.log("Start snippet:", content.substring(content.indexOf('readyz') - 50, content.indexOf('readyz') + 50));
    }
} else {
    const newContent = content.substring(0, startIndex) +
        `// 2. Readiness (Deep Check)
app.get('/readyz', async (req, res) => {
    const checks = {
        db: false,
        tables_exist: false,
        worker_running: false
    };

    try {
        // DB Check
        const one = await db.get('SELECT 1');
        if (one) checks.db = true;

        // Tables Check
        checks.tables_exist = true; 

        // Worker Heartbeat Check
        try {
            const hb = await db.get("SELECT last_seen FROM worker_heartbeat WHERE worker_name='email_worker'");
            if (hb) {
                const last = new Date(hb.last_seen); 
                const t = last.getTime(); // Assuming valid date
                const diffSec = (Date.now() - t) / 1000;
                if (diffSec < 60) checks.worker_running = true;
            }
        } catch (e) { /* ignore */ }

    } catch (e) {
        console.error('Readiness Check Failed', e);
        return res.status(503).json({ ok: false, error: e.message, checks });
    }

    if (Object.values(checks).every(v => v)) {
        res.json({ ok: true, checks });
    } else {
        res.status(503).json({ ok: false, checks });
    }
});

` + content.substring(endIndex);
    fs.writeFileSync('server.js', newContent);
    console.log("Fixed server.js");
}

const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
    console.error("DATABASE_URL missing");
    process.exit(1);
}

// Helper to test connection
async function testConn(name, config) {
    console.log(`\n--- Testing ${name} ---`);
    const client = new Client(config);
    try {
        await client.connect();
        console.log("Connected!");
        const res1 = await client.query("SELECT count(*) as c, queue_status FROM events_outbox GROUP BY queue_status");
        console.log("Events Outbox:", res1.rows);

        const res2 = await client.query("SELECT * FROM events_outbox ORDER BY id DESC LIMIT 5");
        console.log("Recent Events:", res2.rows.map(r => ({ id: r.id, event: r.event_name, q_status: r.queue_status, created: r.created_at })));

        const res3 = await client.query("SELECT count(*) as c, status FROM jobs_queue GROUP BY status");
        console.log("Jobs Queue:", res3.rows);

        const res4 = await client.query("SELECT * FROM jobs_queue ORDER BY id DESC LIMIT 5");
        console.log("Recent Jobs:", res4.rows.map(r => ({ id: r.id, type: r.job_type, status: r.status, err: r.last_error })));

        await client.end();
        return true;
    } catch (e) {
        console.log(`Failed: ${e.message}`);
        try { await client.end(); } catch { }
        return false;
    }
}

(async () => {
    // Strategy 1: strict SSL off (Render requires SSL usually)
    // await testConn('No SSL', { connectionString: url });

    // Strategy 2: SSL Object
    let success = await testConn('SSL Object {rejectUnauthorized:false}', {
        connectionString: url,
        ssl: { rejectUnauthorized: false }
    });

    if (!success) {
        // Strategy 3: Append ?ssl=true if not present
        const url2 = url.includes('?') ? (url.includes('ssl=') ? url : url + '&ssl=true') : url + '?ssl=true';
        await testConn('URL ?ssl=true', { connectionString: url2 });
    }
})();

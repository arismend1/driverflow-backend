const http = require('http');

async function req(method, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json', ...headers }
        };

        const r = http.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const rid = res.headers['x-request-id'];
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data), rid });
                } catch (e) { resolve({ status: res.statusCode, body: data, rid }); }
            });
        });
        r.end();
    });
}

async function run() {
    console.log('--- Phase 3 Verification ---');

    // 1. Healthz
    const h = await req('GET', '/healthz');
    console.log(`[1] /healthz: ${h.status} | RID: ${h.rid} | Uptime: ${h.body.uptime_s}`);

    // 2. Readyz
    const r = await req('GET', '/readyz');
    console.log(`[2] /readyz: ${r.status} | OK: ${r.body.ok} | Checks: ${JSON.stringify(r.body.checks)}`);

    // 3. Metrics (Unauth)
    const mFail = await req('GET', '/metrics');
    console.log(`[3a] /metrics (No Token): ${mFail.status} (Expect 401 if Prod)`);

    // 4. Metrics (Auth) - Simulated if in Prod, or Open in Dev
    // If Dev, it opens. If Prod, we need token.
    // Assuming DEV for verification script.
    const m = await req('GET', '/metrics');
    if (m.status === 200) {
        console.log(`[3b] /metrics: OK | Keys: ${Object.keys(m.body.counters).length}`);
        console.log(`    http_requests_total: ${m.body.counters['http_requests_total{method=GET,route=/healthz,status=200}']}`);
    } else {
        console.log(`[3b] /metrics: ${m.status}`);
    }

}

setTimeout(run, 2000);

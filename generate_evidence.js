const http = require('http');

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidHlwZSI6ImRyaXZlciIsImlhdCI6MTc3MjA4NDA2MX0.32k60fycPbeb90nbCGwhod6ijfy4Bqgignys9rq6zF0';

function request(name, options, body) {
    return new Promise((resolve) => {
        console.log(`\n--- ${name} ---`);
        const req = http.request(options, (res) => {
            console.log(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`);
            Object.keys(res.headers).forEach(h => {
                console.log(`${h}: ${res.headers[h]}`);
            });
            console.log('');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    console.log(JSON.stringify(JSON.parse(data), null, 2));
                } catch {
                    console.log(data);
                }
                resolve();
            });
        });
        req.on('error', e => {
            console.log('ERROR:', e.message);
            resolve();
        });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function run() {
    // 1. Sin token
    await request('GET /api/drivers/profile (No Token)', {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/drivers/profile',
        method: 'GET'
    });

    // 2. Con token
    await request('GET /api/drivers/profile (With Token)', {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/drivers/profile',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${TOKEN}` }
    });

    // 3. PUT con token
    await request('PUT /api/drivers/profile', {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/drivers/profile',
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Content-Type': 'application/json'
        }
    }, { has_cdl: true, experience_years: 12, license_types: ["A", "B"] });

    // 4. GET posterior
    await request('GET /api/drivers/profile (After Update)', {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/drivers/profile',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${TOKEN}` }
    });

    // 5. TICKETS
    await request('GET /api/tickets/my', {
        hostname: '127.0.0.1',
        port: 3000,
        path: '/api/tickets/my',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
}

run();

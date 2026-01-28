const http = require('http');

function request(endpoint, method, body = null) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: endpoint,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        }, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                const contentType = res.headers['content-type'] || '';
                console.log(`[${method} ${endpoint}] Status: ${res.statusCode}`);
                try {
                    const json = JSON.parse(responseBody);
                    resolve({ status: res.statusCode, body: json });
                } catch (e) {
                    resolve({ status: res.statusCode, body: responseBody, error: 'JSON_PARSE_ERROR' });
                }
            });
        });
        req.on('error', (e) => reject(e));
        if (body) req.write(data);
        req.end();
    });
}

(async () => {
    try {
        console.log('\n--- Task 2 Verification ---');

        // 1. Register Mismatch
        console.log('1. Register Mismatch...');
        const reg = await request('/register', 'POST', {
            type: 'driver', nombre: 'Test Strict', contacto: `task2_${Date.now()}@test.com`,
            password: 'abc', confirm_password: 'xyz', tipo_licencia: 'B'
        });
        if (reg.status === 400 && reg.body.error === 'PASSWORDS_DO_NOT_MATCH') {
            console.log('✅ PASS: Register mismatch caught.');
        } else {
            console.error('❌ FAIL: Register', reg);
        }

        // 2. Forgot Password (Mock Mode)
        console.log('2. Forgot Password...');
        const forgot = await request('/forgot_password', 'POST', { type: 'driver', contact: 'test@test.com' });
        if (forgot.status === 200 && forgot.body.success === true) {
            console.log('✅ PASS: Forgot Password returned 200 OK.');
        } else {
            console.error('❌ FAIL: Forgot Password', forgot);
        }

        // 3. Reset Password (Bad Token)
        console.log('3. Reset Password (Bad Token)...');
        const reset = await request('/reset_password', 'POST', {
            type: 'driver', token: 'BAD_TOKEN', new_password: '123', confirm_password: '123'
        });
        if (reset.status === 401 && reset.body.error === 'INVALID_OR_EXPIRED_TOKEN') {
            console.log('✅ PASS: Bad token rejected nicely.');
        } else {
            console.error('❌ FAIL: Reset Password', reset);
        }

    } catch (e) {
        console.error('TEST ERROR:', e);
    }
})();

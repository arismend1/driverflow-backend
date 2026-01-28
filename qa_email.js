const http = require('http');

// Helper for making requests
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
                let json = null;
                try { json = JSON.parse(responseBody); } catch (e) { }
                resolve({ status: res.statusCode, body: json, raw: responseBody });
            });
        });
        req.on('error', (e) => reject(e));
        if (body) req.write(data);
        req.end();
    });
}

(async () => {
    try {
        console.log('\n🔍 QA: ROBUST EMAIL SYSTEM (FINAL - Production Spec)...\n');
        let failures = 0;
        const email = `qa_final_${Date.now()}@test.com`;
        const password = 'Password123!';

        // 1. REGISTER -> Should return require_email_verification: true
        process.stdout.write('1. Register ... ');
        const reg = await request('/register', 'POST', {
            type: 'driver', nombre: 'QA Final', contacto: email,
            password, confirm_password: password, tipo_licencia: 'B'
        });

        if (reg.status === 201 && reg.body.require_email_verification === true) {
            console.log('✅ OK');
        } else {
            console.log('❌ FAIL');
            console.error('   Expected status 201 & require_email_verification=true. Got:', reg.status, reg.body);
            failures++;
        }

        // 2. LOGIN -> Should FAIL with EMAIL_NOT_VERIFIED (403)
        process.stdout.write('2. Login Unverified ... ');
        const loginFail = await request('/login', 'POST', {
            type: 'driver', contacto: email, password
        });
        if (loginFail.status === 403 && loginFail.body.error === 'EMAIL_NOT_VERIFIED') {
            console.log('✅ OK');
        } else {
            console.log('❌ FAIL'); console.error('   Got:', loginFail.status, loginFail.body); failures++;
        }

        console.log('\n📊 SUMMARY: ' + (failures === 0 ? 'PASS (Ready for Deploy)' : `${failures} FAILURES`));

    } catch (e) {
        console.error('TEST ERROR:', e);
    }
})();

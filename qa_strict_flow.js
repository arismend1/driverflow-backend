const http = require('http');
const crypto = require('crypto');

// Helper for making requests
function request(endpoint, method, body = null) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: endpoint,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        if (data) options.headers['Content-Length'] = data.length;

        const req = http.request(options, (res) => {
            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(responseBody); } catch (e) { json = responseBody; } // Handle HTML or Text
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
        console.log('\n🔍 QA: STRICT EMAIL VERIFICATION FLOW (GET)\n');
        let failures = 0;
        const email = `qa_strict_${Date.now()}@test.com`;
        const password = 'Password123!';

        // 1. REGISTER -> Should return success message
        process.stdout.write('1. Register ... ');
        const reg = await request('/register', 'POST', {
            type: 'driver', nombre: 'QA Strict', contacto: email,
            password, confirm_password: password, tipo_licencia: 'B'
        });

        if (reg.status === 201 && reg.body.message.includes('Revisa tu correo')) {
            console.log('✅ OK');
        } else {
            console.log('❌ FAIL');
            console.error('   Expected 201 "Revisa tu correo". Got:', reg.status, reg.body);
            failures++;
        }

        // 2. LOGIN -> Should FAIL with EMAIL_NOT_VERIFIED (403)
        process.stdout.write('2. Login Unverified ... ');
        const loginFail = await request('/login', 'POST', {
            type: 'driver', contacto: email, password
        });
        if (loginFail.status === 403 && loginFail.body.error === 'EMAIL_NOT_VERIFIED') {
            console.log('✅ OK');
            console.log('   (Confirmed blocking works)');
        } else {
            console.log('❌ FAIL'); console.error('   Got:', loginFail.status, loginFail.body); failures++;
        }

        // 3. GET /verify-email (Invalid Token) -> Should fail
        process.stdout.write('3. Verify Invalid Token ... ');
        const verifyFail = await request('/verify-email?token=INVALID&type=driver', 'GET');
        if (verifyFail.status === 400 && verifyFail.raw.includes('Enlace inválido')) {
            console.log('✅ OK (HTML Error returned)');
        } else {
            console.log('❌ FAIL'); console.error('   Got:', verifyFail.status, verifyFail.raw.substring(0, 50)); failures++;
        }

        console.log('\n⚠️  To test POSITIVE verification, check Server Logs for the LINK and paste it in browser or curl.');
        console.log('\n📊 SUMMARY: ' + (failures === 0 ? 'PASS (Logic Valid)' : `${failures} FAILURES`));

    } catch (e) {
        console.error('TEST ERROR:', e);
    }
})();

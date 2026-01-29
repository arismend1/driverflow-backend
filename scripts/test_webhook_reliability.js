const http = require('http');
const crypto = require('crypto');

// Config
const SECRET = 'whsec_test_secret'; // Must match server dummy secret if simplified or real one
const PORT = 3000;
const PATH = '/api/stripe/webhook';
const PAYLOAD = JSON.stringify({
    id: 'evt_test_webhook_' + Date.now(),
    type: 'payment_intent.created',
    data: { object: { id: 'pi_test_123' } }
});

// Create Signature (Mocking Stripe behavior)
const timestamp = Math.floor(Date.now() / 1000);
const signaturePayload = `${timestamp}.${PAYLOAD}`;
const hmac = crypto.createHmac('sha256', SECRET).update(signaturePayload).digest('hex');
const sigHeader = `t=${timestamp},v1=${hmac}`;

const options = {
    hostname: 'localhost',
    port: PORT,
    path: PATH,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json', // Express.raw handles this if configured correctly
        'Stripe-Signature': sigHeader,
        'Content-Length': Buffer.byteLength(PAYLOAD),
        'x-test-bypass-sig': 'true' // Trigger our bypass in server.js test mode
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${data}`);
        if (res.statusCode === 200) {
            console.log('PASS: Webhook accepted (200 OK)');
        } else {
            console.error('FAIL: Webhook rejected');
            process.exit(1);
        }
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
    process.exit(1);
});

// Write data
req.write(PAYLOAD);
req.end();

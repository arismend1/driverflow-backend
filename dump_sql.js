const fs = require('fs');
const https = require('https');

const data = JSON.stringify({ secret: 'surgical_evidence_123' });

const options = {
    hostname: 'driverflow-backend.onrender.com',
    port: 443,
    path: '/api/debug/sql',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = https.request(options, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        fs.writeFileSync('final_sql.json', body);
        console.log("Written!");
    });
});
req.on('error', error => console.error(error));
req.write(data);
req.end();

const https = require('https');

https.get('https://driverflow-backend.onrender.com/', (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
        console.log("Status:", res.statusCode);
        console.log("Body:", data.substring(0, 500));
    });
}).on('error', e => console.error(e));

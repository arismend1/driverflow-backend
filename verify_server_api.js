const http = require('http');

async function get(port) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/sys/debug/email-status`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ port, status: res.statusCode, data }));
        });
        req.on('error', e => reject(e));
    });
}

(async () => {
    const ports = [3000, 10000, 8080, 5000];
    for (const p of ports) {
        try {
            console.log(`Trying port ${p}...`);
            const res = await get(p);
            console.log(`Port ${p} success:`, res.status);
            console.log(res.data.substring(0, 500)); // Print first 500 chars
            return;
        } catch (e) {
            console.log(`Port ${p} failed: ${e.message}`);
        }
    }
    console.log("Could not look up debug status on any common port.");
})();

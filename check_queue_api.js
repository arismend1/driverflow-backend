const jwt = require('jsonwebtoken'); // Need to install or require from node_modules if present?
// If jsonwebtoken is not available in CDW top level, I might need to require from driverflow-mvp/node_modules
// But wait, the CWD of execution is driverflow-mvp. So require('jsonwebtoken') should work.

const SECRET = process.env.SECRET_KEY || 'dev_secret_key_123';
const token = jwt.sign({ role: 'admin', id: 999 }, SECRET, { expiresIn: '1h' });

async function main() {
    try {
        const res = await fetch('http://localhost:3000/queue/stats', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        console.log('API STATS:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Fetch Error:', e.message);
    }
}
main();

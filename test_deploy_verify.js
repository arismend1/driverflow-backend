const axios = require('axios');

async function verify() {
    const API_URL = 'https://driverflow-backend.onrender.com';
    const email = `test_verify_${Date.now()}@driverflow.com`;
    const password = 'Password123';

    try {
        console.log('1. Registering test driver...');
        const regRes = await axios.post(`${API_URL}/register`, {
            type: 'driver',
            nombre: 'Verify Driver',
            contacto: email,
            password: password
        });
        console.log('Register Success:', regRes.data.success);

        console.log('2. Logging in...');
        const loginRes = await axios.post(`${API_URL}/login`, {
            type: 'driver',
            contacto: email,
            password: password
        });
        const token = loginRes.data.token;
        console.log('Login Success:', !!token);

        if (!token) throw new Error('Login failed');

        console.log('3. Triggering matching engine (/matches/opportunities)...');
        const oppRes = await axios.get(`${API_URL}/matches/opportunities`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        console.log('Opportunities Count:', oppRes.data.length);
        console.log('Verification COMPLETE');

    } catch (e) {
        console.error('Verification FAILED:', e.response ? e.response.data : e.message);
        process.exit(1);
    }
}

verify();

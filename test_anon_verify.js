const axios = require('axios');

async function verify() {
    const API_URL = 'https://driverflow-backend.onrender.com';
    const email = 'test123477@test.com'; // Known test account
    const password = 'Password123';

    try {
        console.log('1. Checking Service Version...');
        const versionRes = await axios.get(`${API_URL}/api/diagnostics/version`);
        console.log('Version:', versionRes.data.version);
        console.log('Startup:', versionRes.data.startup_at);

        console.log('\n2. Logging in with existing account...');
        const loginRes = await axios.post(`${API_URL}/login`, {
            type: 'empresa', // test_api_2 uses empresa
            contacto: email,
            password: password
        });
        const token = loginRes.data.token;
        console.log('Login Success:', !!token);

        if (!token) throw new Error('Login failed');

        console.log('\n3. Verifying Anonymity in /matches/candidates...');
        const candRes = await axios.get(`${API_URL}/matches/candidates`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });

        if (candRes.data.length > 0) {
            const match = candRes.data[0];
            console.log('Match Status:', match.status);
            console.log('Display Name:', match.display_name);
            console.log('Driver Name (should be null):', match.driver_name);

            const isAnonProper = match.display_name.startsWith('Driver #') && 
                                (match.driver_name === null || match.driver_name === undefined);
            
            console.log('Anonymization Verified:', isAnonProper);
            
            if (!isAnonProper && match.status !== 'INFO_SHARED' && match.status !== 'HIRED') {
                console.error('CRITICAL: Real name exposed in JSON!');
            }
        } else {
            console.log('No matches (candidates) available to verify.');
        }

        console.log('\nVerification cycle complete.');

    } catch (e) {
        console.error('Verification FAILED:', e.response ? e.response.data : e.message);
        process.exit(1);
    }
}

verify();

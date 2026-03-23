const axios = require('axios');

async function debugRegister() {
    try {
        const res = await axios.post('https://driverflow-backend.onrender.com/register', {
            type: 'driver',
            nombre: 'Debug',
            contacto: `debug_${Date.now()}@test.com`,
            phone: '5550001111',
            password: 'Password123!',
            tipo_licencia: 'B'
        });
        console.log("Success:", res.status);
    } catch (err) {
        console.error("Status:", err.response?.status);
        console.error("Headers:", err.response?.headers);
        const data = err.response?.data;
        if (typeof data === 'string') {
            console.error("Body slice:", data.substring(0, 500));
        } else {
            console.error("Body JSON:", JSON.stringify(data));
        }
    }
}
debugRegister();

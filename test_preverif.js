const axios = require('axios');

const API_URL = 'https://driverflow-backend.onrender.com';
const SECRET = 'surgical_evidence_123';
const timestamp = Date.now();
const driverEmail = `preverif_${timestamp}@test.com`;

const driver = {
    type: 'driver',
    nombre: `PreVerif Driver ${timestamp}`,
    contacto: driverEmail,
    phone: `555${timestamp.toString().slice(-7)}`,
    password: 'Password123!',
    tipo_licencia: 'A'
};

async function run() {
    try {
        console.log("Registering driver...");
        await axios.post(`${API_URL}/register`, driver);

        console.log("Fetching SQL Evidence...");
        const res = await axios.post(`${API_URL}/api/debug/sql`, {
            secret: SECRET,
            emails: [driverEmail]
        });

        console.log("SELECT id, nombre, email, contacto, phone, verified, status FROM drivers ORDER BY id DESC LIMIT 5;");
        console.table(res.data.drivers);

    } catch (e) {
        console.error(e.message);
        if (e.response) console.error(e.response.data);
    }
}
run();

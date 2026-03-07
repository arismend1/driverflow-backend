const axios = require('axios');

const API_URL = 'http://localhost:3000'; // Assuming server is running here

async function testRegistration() {
    console.log("--- Starting Registration Uniqueness Verification ---");

    const driver1 = {
        type: 'driver',
        nombre: 'Test Driver 1',
        contacto: 'driver1@test.com',
        phone: '1234567890',
        password: 'Password123!',
        tipo_licencia: 'A'
    };

    const company1 = {
        type: 'empresa',
        nombre: 'Test Company 1',
        contacto: 'company1@test.com',
        phone: '9876543210',
        password: 'Password123!',
        legal_name: 'Test Co 1'
    };

    try {
        // 1. Register Driver 1
        console.log("1. Registering Driver 1...");
        const res1 = await axios.post(`${API_URL}/register`, driver1);
        console.log("✅ Success:", res1.data.message);

        // 2. Register Company 1
        console.log("2. Registering Company 1...");
        const res2 = await axios.post(`${API_URL}/register`, company1);
        console.log("✅ Success:", res2.data.message);

        // 3. Duplicate Email (Driver using Company 1 Email)
        console.log("3. Attempting duplicate email (Driver using Company 1 Email)...");
        try {
            await axios.post(`${API_URL}/register`, { ...driver1, contacto: company1.contacto, phone: '0000000000' });
        } catch (e) {
            console.log("✅ Expected Failure:", e.response?.data?.error || e.message);
        }

        // 4. Duplicate Phone (Company using Driver 1 Phone)
        console.log("4. Attempting duplicate phone (Company using Driver 1 Phone)...");
        try {
            await axios.post(`${API_URL}/register`, { ...company1, contacto: 'unique@test.com', phone: driver1.phone });
        } catch (e) {
            console.log("✅ Expected Failure:", e.response?.data?.error || e.message);
        }

        console.log("--- Verification Finished ---");
    } catch (e) {
        console.error("❌ TEST FAILED:", e.response?.data || e.message);
    }
}

testRegistration();

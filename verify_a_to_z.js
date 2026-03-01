const http = require('http');

const API_URL = 'http://localhost:3000';

async function req(method, path, body, token = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(API_URL + path);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (token) options.headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function loginOrRegister(type, email, pwd, name) {
    console.log(`\nAttempting Login for [${type}] ${email}...`);
    let res = await req('POST', '/login', { type, contacto: email, password: pwd });

    if (res.status === 401) {
        console.log(`Login failed. Attempting to Register [${type}] ${email}...`);
        const regPayload = { type, nombre: name, contacto: email, password: pwd };
        if (type === 'empresa') {
            Object.assign(regPayload, {
                legal_name: name,
                address_line1: '123 Test St',
                address_city: 'Miami',
                contact_person: 'John Doe'
            });
        } else {
            regPayload.tipo_licencia = 'A';
        }

        let regRes = await req('POST', '/register', regPayload);
        if (regRes.status !== 200) {
            console.error("Register Failed!", regRes.status, regRes.data);
            return null;
        }
        console.log("Registration OK. Re-logging in...");
        res = await req('POST', '/login', { type, contacto: email, password: pwd });
    }

    return res.data;
}

async function run() {
    console.log("=== STARTING A-Z VIRTUAL TEST ===");

    // 1. Company Auth
    const coData = await loginOrRegister('empresa', 'luxuryservicesfl@gmail.com', 'Angeles2515@', 'Luxury Services FL');
    if (!coData || !coData.token) return;
    const coToken = coData.token;
    console.log("✅ Company Auth Success");

    // 2. Company Update Requirements
    console.log("\n[2] Company Updating Requirements...");
    const reqRes = await req('PUT', '/api/companies/requirements', {
        req_operation_types: ['OTR'],
        offered_payment_methods: ['Por milla'],
        req_experience_years: 3,
        req_modalities: ['Tiempo Completo'],
        availability: 'Inmediata'
    }, coToken);
    console.log("Response:", reqRes.status, reqRes.data);

    // 3. Company Toggle Search Status
    console.log("\n[3] Company Toggling Search Status to ON...");
    const coSearchRes = await req('POST', '/api/company/search_status', { status: 'ON' }, coToken);
    console.log("Response:", coSearchRes.status, coSearchRes.data);

    // 4. Driver Auth
    const drData = await loginOrRegister('driver', 'anglorangzam@gmail.com', 'Angeles2515@', 'Angel Driver');
    if (!drData || !drData.token) return;
    const drToken = drData.token;
    console.log("✅ Driver Auth Success");

    // 5. Driver Update Profile
    console.log("\n[5] Driver Updating Profile...");
    const drUpdateRes = await req('PUT', '/api/drivers/profile', {
        operation_types: ['OTR'],
        payment_methods: ['Por milla'],
        experience_years: 3,
        job_preferences: ['Tiempo Completo'],
        availability: 'Inmediata'
    }, drToken);
    console.log("Response:", drUpdateRes.status, drUpdateRes.data);

    // 6. Check Matches (As Company)
    console.log("\n[6] Checking Matches (As Company)...");
    const matchRes = await req('GET', '/api/tickets/my', null, coToken);
    console.log("Total Matches found:", matchRes.data.length);
    if (matchRes.data.length > 0) {
        console.log("✅ Matching Logic Successfully Linked Driver and Company!");
    } else {
        console.log("⚠️ No matches immediately found (Maybe Chron job hasn't run or constraints missed).");
    }

    console.log("\n=== TEST COMPLETE ===");
}

run().catch(console.error);

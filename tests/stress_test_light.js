// Native fetch is available in Node 18+
const Database = require('better-sqlite3');
const db = new Database('c:/Users/dj23/Desktop/DriverFlow/driverflow-mvp/driverflow.db');

const BASE_URL = 'http://localhost:3000'; // Change to Prod URL if testing remote
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin_secret_123'; // If needed for cleanups

// Config
const NUM_COMPANIES = 20;
const NUM_DRIVERS = 5;
const REQUESTS_PER_COMPANY = 1; // 20 * 1 = 20 total requests

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function post(endpoint, body, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) console.log('ERROR POST', endpoint, res.status, JSON.stringify(data));
    return { status: res.status, data };
}

async function main() {
    console.log('--- Phase 6.1: Light Stress Test (The "Tranquilo" Load) ---');
    console.log(`Target: ${BASE_URL}\n`);

    const companies = [];
    const drivers = [];

    // 1. Create Companies
    console.log(`1. Registering ${NUM_COMPANIES} Companies...`);
    for (let i = 0; i < NUM_COMPANIES; i++) {
        const id = Date.now() + i;
        const res = await post('/register', {
            type: 'empresa',
            nombre: `Stress Co ${id}`,
            contacto: `stress_co_${id}@test.com`,
            password: 'StrongPassword1!',
            legal_name: `Stress Corp ${id}`,
            address_city: 'Metropolis'
        });

        if (res.data.ok) {
            // Login to get token (Skip verification hack? Need to verify in DB first if strictly enforced)
            // HACK: Manually verify via DB for speed if local
            try {
                const email = `stress_co_${id}@test.com`;
                const user = db.prepare("SELECT * FROM empresas WHERE contacto=?").get(email);
                console.log(`   (Found User: ${user ? user.id : 'NONE'})`);
                const info = db.prepare("UPDATE empresas SET verified=1 WHERE contacto=?").run(email);
                console.log(`   (DB Update: ${info.changes} rows verified)`);
            } catch (e) {
                console.log('   (DB Update Failed)', e.message);
            }

            const login = await post('/login', {
                type: 'empresa',
                contacto: `stress_co_${id}@test.com`,
                password: 'StrongPassword1!'
            });
            if (login.data.token) {
                companies.push(login.data);
                // Turn SEARCH ON
                await post('/company/search_status', { status: 'ON' }, login.data.token);
            }
        }
    }
    console.log(`   -> Created ${companies.length} active companies.`);

    // 2. Create Drivers
    console.log(`\n2. Registering ${NUM_DRIVERS} Drivers...`);
    for (let i = 0; i < NUM_DRIVERS; i++) {
        const id = Date.now() + i;
        const res = await post('/register', {
            type: 'driver',
            nombre: `Stress Driver ${id}`,
            contacto: `stress_driver_${id}@test.com`,
            password: 'StrongPassword1!',
            tipo_licencia: 'C'
        });

        if (res.data.ok) {
            try {
                db.prepare("UPDATE drivers SET verified=1 WHERE contacto=?").run(`stress_driver_${id}@test.com`);
            } catch (e) { console.log('   (DB Update Failed)', e.message); }

            const login = await post('/login', {
                type: 'driver',
                contacto: `stress_driver_${id}@test.com`,
                password: 'StrongPassword1!'
            });
            if (login.data.token) {
                drivers.push(login.data);
            }
        }
    }
    console.log(`   -> Created ${drivers.length} active drivers.`);

    // 3. Generate Load (Requests)
    console.log(`\n3. Generating Requests (${companies.length * REQUESTS_PER_COMPANY} total)...`);
    let reqCount = 0;

    for (const co of companies) {
        for (let j = 0; j < REQUESTS_PER_COMPANY; j++) {
            const res = await post('/create_request', {
                licencia_req: 'C',
                ubicacion: 'Central Station',
                tiempo_estimado: '2h',
                pago_ofrecido: 5000,
                descripcion: `Stress Load Test ${j}`
            }, co.token);

            if (res.status === 200 || res.status === 201) {
                process.stdout.write('.');
                reqCount++;
            } else {
                process.stdout.write('x');
            }
            await sleep(50); // Slight delay to separate events
        }
    }
    console.log(`\n   -> Successfully created ${reqCount} requests.`);

    console.log('\n--- Load Generation Complete ---');
    console.log('Monitor queues via: GET /queue/stats');
}

main().catch(console.error);

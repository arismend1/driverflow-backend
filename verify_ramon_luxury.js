const { request } = require('http');

async function req(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const reqStr = JSON.stringify(body || {});
        const options = {
            hostname: 'localhost', port: 3000, path, method,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqStr) }
        };
        if (token) options.headers['Authorization'] = `Bearer ${token}`;

        const reqHttp = request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch (e) { }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        reqHttp.on('error', reject);
        if (body) reqHttp.write(reqStr);
        reqHttp.end();
    });
}

(async () => {
    try {
        console.log('--- Logging in Ramon D ---');
        let resDrv = await req('POST', '/login', { type: 'driver', contacto: 'ramon@example.com', password: 'Password123!' }); // Assuming ramon email
        // Or wait, I don't know Ramon's email. I should do it directly via DB.

        const db = require('./db_adapter');
        const driver = await db.get("SELECT contacto, id FROM drivers WHERE nombre LIKE '%Ramon%'");
        const company = await db.get("SELECT unnest(array_agg(id)) AS id, contacto FROM empresas WHERE nombre LIKE '%Luxury%' OR contacto LIKE '%luxury%' GROUP BY contacto LIMIT 1");

        console.log("Driver:", driver.contacto);
        console.log("Company:", company.contacto);

        // Login Driver
        const loginDrv = await req('POST', '/login', { type: 'driver', contacto: driver.contacto, password: 'Password123!' });
        let drvToken = loginDrv.body.token || (await req('POST', '/login', { type: 'driver', contacto: driver.contacto, password: 'password' })).body.token;
        if (!drvToken) {
            // fallback force token gen
            const jwt = require('jsonwebtoken');
            drvToken = jwt.sign({ id: driver.id, type: 'driver' }, process.env.JWT_SECRET || 'test_secret', { expiresIn: '24h' });
        }

        // Login Company
        const loginCmp = await req('POST', '/login', { type: 'empresa', contacto: company.contacto, password: 'Password123!' });
        let cmpToken = loginCmp.body.token || (await req('POST', '/login', { type: 'empresa', contacto: company.contacto, password: 'password' })).body.token;
        if (!cmpToken) {
            const jwt = require('jsonwebtoken');
            cmpToken = jwt.sign({ id: company.id, type: 'empresa' }, process.env.JWT_SECRET || 'test_secret', { expiresIn: '24h' });
        }

        const match = await db.get(`
            SELECT pm.id, pm.status 
            FROM potential_matches pm 
            WHERE pm.driver_id = ? AND pm.status NOT IN ('DECLINED', 'EXPIRED')
            AND pm.company_id IN (SELECT id FROM empresas WHERE LOWER(TRIM(contacto)) = LOWER(TRIM(?)))
        `, driver.id, company.contacto);

        console.log("Match ID to verify:", match.id, "Status:", match.status);

        if (match.status !== 'PREMATCH_READY') {
            console.log("Forcing PREMATCH_READY...");
            await db.run("UPDATE potential_matches SET status = 'PREMATCH_READY', driver_step1_accepted_at=NOW(), company_step1_accepted_at=NOW() WHERE id=?", match.id);
        }

        // 1. Driver Consents
        console.log("\\n[Step 1] Driver Confirms Share...");
        const res1 = await req('POST', `/matches/${match.id}/driver/confirm-share`, null, drvToken);
        console.log("Driver response:", res1.body);

        // 2. See Intermediate Status
        const step1db = await db.get("SELECT status, driver_share_consent_at, company_share_consent_at FROM potential_matches WHERE id=?", match.id);
        console.log("DB After Driver:", step1db);

        // 3. Company Consents
        console.log("\\n[Step 2] Company Confirms Share...");
        const res2 = await req('POST', `/matches/${match.id}/company/confirm-share`, null, cmpToken);
        console.log("Company response:", res2.body);

        // 4. Final Verification
        const finaldb = await db.get("SELECT status, driver_share_consent_at, company_share_consent_at, info_shared_at, ticket_id FROM potential_matches WHERE id=?", match.id);
        console.log("\\n--- FINAL RESULT ---");
        console.log(finaldb);

        process.exit(0);

    } catch (e) {
        console.error(e);
    }
})();

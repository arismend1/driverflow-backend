require('dotenv').config();
const db = require('./db_adapter');
const jwt = require('jsonwebtoken');

// Matches server.js default if missing
const SECRET_KEY = process.env.SECRET_KEY || process.env.JWT_SECRET || 'test_secret_key';

async function testEndpoint() {
    console.log("--- TEST ENDPOINT /api/billing/invoices/me ---");
    const nowIso = new Date().toISOString();

    const emp1 = await db.get("SELECT id FROM empresas ORDER BY id ASC LIMIT 1");
    const emp2 = await db.get("SELECT id FROM empresas WHERE id != ? ORDER BY id ASC LIMIT 1", emp1.id);

    if (!emp1 || !emp2) { console.log("Se requieren al menos 2 empresas en DB."); process.exit(1); }

    await db.run("DELETE FROM weekly_invoices WHERE id IN (9001, 9002)");
    await db.run(`INSERT INTO weekly_invoices (company_id, week_start, week_end, amount_cents, status, receipt_url, created_at, id) VALUES (?, '2023-11-01', '2023-11-07', 15000, 'charged', 'https://receipt.stripe.com/1', ?, 9001)`, emp1.id, nowIso);
    await db.run(`INSERT INTO weekly_invoices (company_id, week_start, week_end, amount_cents, status, receipt_url, created_at, id) VALUES (?, '2023-11-01', '2023-11-07', 25000, 'charged', 'https://receipt.stripe.com/2', ?, 9002)`, emp2.id, nowIso);

    const token1 = jwt.sign({ id: emp1.id, type: 'empresa' }, SECRET_KEY, { expiresIn: '1h' });
    const token2 = jwt.sign({ id: emp2.id, type: 'empresa' }, SECRET_KEY, { expiresIn: '1h' });

    console.log("Consultando con el Token de la Empresa A...");
    let res1;
    try {
        res1 = await fetch('http://localhost:3000/api/billing/invoices/me', { headers: { Authorization: `Bearer ${token1}` } });
    } catch (e) {
        console.log("No se pudo conectar a localhost:3000. Asegurate que node server.js esté ejecutándose.");
        process.exit(1);
    }

    let data1 = await res1.json();
    console.log("EMPRESA A fetched:", data1.length, "invoices");

    const pass1 = data1.some(i => i.id === 9001 && i.receipt_url === 'https://receipt.stripe.com/1');
    const secure1 = !data1.some(i => i.id === 9002);

    console.log("Consultando con el Token de la Empresa B...");
    let res2 = await fetch('http://localhost:3000/api/billing/invoices/me', { headers: { Authorization: `Bearer ${token2}` } });
    let data2 = await res2.json();

    const pass2 = data2.some(i => i.id === 9002 && i.receipt_url === 'https://receipt.stripe.com/2');
    const secure2 = !data2.some(i => i.id === 9001);

    if (pass1 && secure1 && pass2 && secure2) {
        console.log("✅ EXITOSO: /api/billing/invoices/me retorna receipt_url correctamente y aisla la seguridad de empresas.");
    } else {
        console.log("❌ FALLO en Endpoint. Revisar datos:", { pass1, secure1, pass2, secure2 });
    }
    process.exit(0);
}

testEndpoint();

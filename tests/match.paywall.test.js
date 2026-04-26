const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverflow-match-paywall-'));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret';
process.env.RUN_MIGRATIONS = 'false';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DATABASE_URL;

const app = require('../server');
const db = require('../db_adapter');

beforeAll(async () => {
    await db.exec(`
        CREATE TABLE empresas (
            id INTEGER PRIMARY KEY,
            nombre TEXT,
            contacto TEXT,
            verification_status TEXT,
            billing_suspended INTEGER DEFAULT 0
        );

        CREATE TABLE drivers (
            id INTEGER PRIMARY KEY,
            nombre TEXT,
            contacto TEXT
        );

        CREATE TABLE potential_matches (
            id INTEGER PRIMARY KEY,
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            info_shared_at TEXT,
            ticket_id INTEGER,
            exclusivity_extension_hours INTEGER DEFAULT 0,
            resolution_company TEXT,
            resolution_driver TEXT,
            updated_at TEXT
        );
    `);

    await db.run(
        `INSERT INTO empresas (id, nombre, contacto, verification_status, billing_suspended)
         VALUES (?, ?, ?, ?, ?)`,
        3001,
        'Empresa Paywall Test',
        'empresa_paywall_test@demo.com',
        'approved',
        0
    );

    await db.run(
        `INSERT INTO drivers (id, nombre, contacto)
         VALUES (?, ?, ?)`,
        3002,
        'Driver Paywall Test',
        'driver_paywall_test@demo.com'
    );

    await db.run(
        `INSERT INTO potential_matches (id, company_id, driver_id, status, info_shared_at, ticket_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        888888,
        3001,
        3002,
        'PAYMENT_REQUIRED',
        null,
        null
    );
});

afterAll(() => {
    try {
        db.close?.();
    } catch (err) {
        // DB cleanup is best-effort only.
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('match en PAYMENT_REQUIRED no permite flujo desbloqueado', async () => {
    const token = jwt.sign(
        {
            id: 3001,
            type: 'empresa',
            legal_accepted: true,
            legal_version: 'v1'
        },
        process.env.JWT_SECRET
    );

    const res = await request(app)
        .post('/api/matches/888888/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({ resolution: 'HIRED' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_match_state');
});

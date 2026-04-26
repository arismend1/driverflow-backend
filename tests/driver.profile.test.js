const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverflow-driver-profile-'));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret';
process.env.RUN_MIGRATIONS = 'false';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DATABASE_URL;

const app = require('../server');
const db = require('../db_adapter');

beforeAll(async () => {
    await db.exec(`
        CREATE TABLE drivers (
            id INTEGER PRIMARY KEY,
            nombre TEXT,
            contacto TEXT,
            profile_photo_url TEXT,
            license_front_url TEXT,
            license_back_url TEXT,
            has_cdl INTEGER DEFAULT 0,
            license_types TEXT,
            endorsements TEXT,
            operation_types TEXT,
            experience_years INTEGER DEFAULT 0,
            job_preferences TEXT,
            has_truck INTEGER DEFAULT 0,
            payment_methods TEXT,
            work_relationships TEXT,
            availability TEXT,
            city TEXT,
            state TEXT,
            weekly_miles INTEGER,
            longest_otr TEXT,
            trailer_experience TEXT,
            accidents_3y INTEGER DEFAULT 0,
            tickets_3y INTEGER DEFAULT 0,
            home_time TEXT,
            preferred_freight TEXT,
            preferred_region TEXT,
            willing_to_relocate INTEGER DEFAULT 0,
            driver_bio TEXT,
            willing_travel_interview INTEGER DEFAULT 0,
            search_status TEXT DEFAULT 'ON',
            updated_at TEXT
        );

        CREATE TABLE empresas (
            id INTEGER PRIMARY KEY,
            nombre TEXT
        );

        CREATE TABLE potential_matches (
            id INTEGER PRIMARY KEY,
            company_id INTEGER,
            driver_id INTEGER,
            status TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE driver_operation_types (
            driver_id INTEGER,
            value TEXT
        );

        CREATE TABLE driver_license_types (
            driver_id INTEGER,
            value TEXT
        );

        CREATE TABLE driver_endorsements (
            driver_id INTEGER,
            value TEXT
        );

        CREATE TABLE driver_payment_methods (
            driver_id INTEGER,
            value TEXT
        );

        CREATE TABLE driver_work_relationships (
            driver_id INTEGER,
            value TEXT
        );

        CREATE TABLE driver_job_preferences (
            driver_id INTEGER,
            value TEXT
        );
    `);

    await db.run(
        `INSERT INTO drivers (
            id,
            nombre,
            contacto,
            profile_photo_url,
            license_front_url,
            license_back_url,
            availability
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        5001,
        'Driver Test',
        'driver@test.com',
        'photo1.jpg',
        'license1.jpg',
        'license2.jpg',
        'Old Availability'
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

test('actualizar profile no borra campos existentes', async () => {
    const token = jwt.sign(
        {
            id: 5001,
            type: 'driver',
            legal_accepted: true,
            legal_version: 'v1'
        },
        process.env.JWT_SECRET
    );

    const res = await request(app)
        .put('/api/drivers/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({
            nombre: 'Driver Updated',
            availability: 'Available Now'
        });

    expect(res.status).toBe(200);

    const updated = await db.get('SELECT * FROM drivers WHERE id = ?', 5001);

    expect(updated.availability).toBe('Available Now');
    expect(updated.profile_photo_url).toBe('photo1.jpg');
    expect(updated.license_front_url).toBe('license1.jpg');
    expect(updated.license_back_url).toBe('license2.jpg');
});

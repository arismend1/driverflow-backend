const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverflow-debug-endpoints-'));

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test_secret';
process.env.RUN_MIGRATIONS = 'false';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DATABASE_URL;

const app = require('../server');
const db = require('../db_adapter');

afterAll(() => {
    try {
        db.close?.();
    } catch (err) {
        // DB cleanup is best-effort only.
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('/api/debug/sql debe devolver 404 en produccion', async () => {
    const res = await request(app)
        .post('/api/debug/sql')
        .send({});

    expect(res.status).toBe(404);
});

test('/sys/debug/reset-jobs debe devolver 404 en produccion', async () => {
    const res = await request(app)
        .post('/sys/debug/reset-jobs');

    expect(res.status).toBe(404);
});

test('/api/diagnostics/debug-duplicates debe devolver 404 en produccion', async () => {
    const res = await request(app)
        .get('/api/diagnostics/debug-duplicates');

    expect(res.status).toBe(404);
});

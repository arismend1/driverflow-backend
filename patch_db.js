const db = require('better-sqlite3')('driverflow.db');

try {
    db.prepare('ALTER TABLE drivers ADD COLUMN has_cdl INTEGER DEFAULT 0;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN license_types TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN endorsements TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN operation_types TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN experience_years INTEGER DEFAULT 0;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN job_preferences TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN has_truck INTEGER DEFAULT 0;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN payment_methods TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN work_relationships TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN availability TEXT;').run();
    db.prepare('ALTER TABLE drivers ADD COLUMN updated_at TEXT;').run();
} catch (e) { }

try {
    db.prepare('ALTER TABLE company_requirements ADD COLUMN req_experience_years INTEGER DEFAULT 0;').run();
} catch (e) { }
console.log('Tables patched for SQLite V2 payloads');

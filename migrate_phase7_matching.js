const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'driverflow.db');
console.log(`--- Migrating: Phase 7 Advanced Matching System ---`);
console.log(`Database: ${dbPath}`);

const db = new Database(dbPath);

try {
    // 1. Driver Profiles
    db.prepare(`CREATE TABLE IF NOT EXISTS driver_profiles (
        driver_id INTEGER PRIMARY KEY,
        has_cdl INTEGER DEFAULT 0, 
        license_types TEXT, 
        endorsements TEXT, 
        operation_types TEXT, 
        experience_years INTEGER,
        experience_range TEXT, 
        job_preferences TEXT, 
        has_truck INTEGER DEFAULT 0, 
        payment_methods TEXT, 
        work_relationships TEXT, 
        updated_at TEXT,
        FOREIGN KEY(driver_id) REFERENCES drivers(id)
    )`).run();
    console.log("✅ Table 'driver_profiles' ready.");

    // 2. Company Requirements
    db.prepare(`CREATE TABLE IF NOT EXISTS company_requirements (
        company_id INTEGER PRIMARY KEY,
        req_cdl INTEGER DEFAULT 0, 
        req_license_types TEXT, 
        req_endorsements TEXT, 
        req_operation_types TEXT, 
        req_experience_range TEXT, 
        req_modalities TEXT, 
        req_truck INTEGER DEFAULT 0, 
        offered_payment_methods TEXT, 
        req_relationships TEXT, 
        availability TEXT, 
        updated_at TEXT,
        FOREIGN KEY(company_id) REFERENCES empresas(id)
    )`).run();
    console.log("✅ Table 'company_requirements' ready.");

    // 3. Matches
    db.prepare(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        driver_id INTEGER,
        status TEXT DEFAULT 'pending', 
        score INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY(company_id) REFERENCES empresas(id),
        FOREIGN KEY(driver_id) REFERENCES drivers(id)
    )`).run();
    console.log("✅ Table 'matches' ready.");

    // Indices
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_matches_company ON matches(company_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_matches_driver ON matches(driver_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status)`).run();

} catch (err) {
    console.error("Migration Failed:", err.message);
    process.exit(1);
}

console.log("--- Migration Phase 7 Complete ---");

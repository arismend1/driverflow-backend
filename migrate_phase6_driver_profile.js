/**
 * Phase 6: Driver Profile Value Upgrade Migration
 * Adds new informational columns to drivers table
 * Creates driver_media table for photos (separate from drivers)
 */
const db = require('./db_adapter');

console.log('--- [PHASE 6] Driver Profile Value Upgrade Migration ---');

(async () => {
    // Safe Add Column helper
    async function safeAdd(table, col, type) {
        try {
            await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
            console.log(`✅ Added ${table}.${col}`);
        } catch (e) {
            if (e.message && (e.message.includes('duplicate') || e.message.includes('exists') || e.message.includes('already'))) {
                console.log(`⏭️  ${table}.${col} already exists`);
            } else {
                console.warn(`⚠️  ${table}.${col}: ${e.message}`);
            }
        }
    }

    try {
        // 1. Create driver_media table (photos separate from drivers)
        console.log('Creating driver_media table...');
        await db.run(`
            CREATE TABLE IF NOT EXISTS driver_media (
                driver_id INTEGER PRIMARY KEY,
                profile_photo_base64 TEXT,
                license_front_base64 TEXT,
                license_back_base64 TEXT,
                photo_consent_at TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        `);
        console.log('✅ driver_media table ready');

        // 2. Add informational columns to drivers table
        console.log('Adding new columns to drivers table...');
        await safeAdd('drivers', 'weekly_miles', 'INTEGER');
        await safeAdd('drivers', 'longest_otr', 'TEXT');
        await safeAdd('drivers', 'trailer_experience', 'TEXT');  // JSON array
        await safeAdd('drivers', 'accidents_3y', 'INTEGER DEFAULT 0');
        await safeAdd('drivers', 'tickets_3y', 'INTEGER DEFAULT 0');
        await safeAdd('drivers', 'home_time', 'TEXT');
        await safeAdd('drivers', 'preferred_freight', 'TEXT');
        await safeAdd('drivers', 'preferred_region', 'TEXT');
        await safeAdd('drivers', 'willing_to_relocate', 'INTEGER DEFAULT 0');
        await safeAdd('drivers', 'driver_bio', 'TEXT');

        // city and state may already exist on drivers from earlier migration
        await safeAdd('drivers', 'city', 'TEXT');
        await safeAdd('drivers', 'state', 'TEXT');

        console.log('✅ [PHASE 6] Migration Complete');
        process.exit(0);
    } catch (e) {
        console.error('❌ [PHASE 6] Migration Failed:', e);
        process.exit(1);
    }
})();

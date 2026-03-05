/**
 * Migration: OTR eligibility columns + indexes
 *
 * Adds OTR-specific signals to drivers and company_requirements
 * for candidate pool filtering without geo-radius.
 */

const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: OTR eligibility columns + indexes ---');

    // ─── Schema: drivers ────────────────────────────────────────────────
    const driverColumns = [
        {
            name: 'willing_to_travel',
            sql: `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS willing_to_travel BOOLEAN NOT NULL DEFAULT true`
        },
        {
            name: 'available_from_date',
            sql: `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS available_from_date DATE NULL`
        },
        {
            name: 'home_time_weeks',
            sql: `ALTER TABLE drivers ADD COLUMN IF NOT EXISTS home_time_weeks INTEGER NULL`
        }
    ];

    for (const { name, sql } of driverColumns) {
        try {
            await db.run(sql);
            console.log(`✅ drivers.${name} added`);
        } catch (e) {
            if (e.message && (e.message.includes('already exists') || e.message.includes('duplicate column'))) {
                console.log(`⚠️ drivers.${name} already exists`);
            } else {
                console.error(`❌ drivers.${name}: ${e.message}`);
            }
        }
    }

    // ─── Schema: company_requirements ────────────────────────────────────
    const crColumns = [
        {
            name: 'requires_immediate_start',
            sql: `ALTER TABLE company_requirements ADD COLUMN IF NOT EXISTS requires_immediate_start BOOLEAN NOT NULL DEFAULT false`
        }
    ];

    for (const { name, sql } of crColumns) {
        try {
            await db.run(sql);
            console.log(`✅ company_requirements.${name} added`);
        } catch (e) {
            if (e.message && (e.message.includes('already exists') || e.message.includes('duplicate column'))) {
                console.log(`⚠️ company_requirements.${name} already exists`);
            } else {
                console.error(`❌ company_requirements.${name}: ${e.message}`);
            }
        }
    }

    // ─── Indexes ────────────────────────────────────────────────────────
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_drivers_search_status ON drivers(search_status)',
        'CREATE INDEX IF NOT EXISTS idx_drivers_willing_travel_true ON drivers(willing_to_travel) WHERE willing_to_travel = true',
        'CREATE INDEX IF NOT EXISTS idx_drivers_available_from ON drivers(available_from_date)',
        'CREATE INDEX IF NOT EXISTS idx_drivers_has_truck_true ON drivers(has_truck) WHERE has_truck = true',
        'CREATE INDEX IF NOT EXISTS idx_cr_company_id ON company_requirements(company_id)',
        'CREATE INDEX IF NOT EXISTS idx_cr_requires_immediate ON company_requirements(requires_immediate_start)'
    ];

    for (const sql of indexes) {
        try {
            await db.run(sql);
            const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
            console.log(`✅ Index ${name} OK`);
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
                console.log(`⚠️ Index ${name} already exists`);
            } else {
                console.error(`❌ Index error: ${e.message}`);
            }
        }
    }

    console.log('✅ OTR eligibility migration complete');
    process.exit(0);
})();

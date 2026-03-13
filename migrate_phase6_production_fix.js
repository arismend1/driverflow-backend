/**
 * Phase 6 production hotfix: Consolidated Schema Update
 * This script ensures all Phase 6 company-side columns exist in the database.
 * Supports both PostgreSQL and SQLite (fallback).
 */
const db = require('./db_adapter');

async function migrate() {
    console.log('[MIGRATION] Starting Phase 6 production schema hotfix...');

    const companyReqTable = 'company_requirements';
    const empresasTable = 'empresas';

    try {
        if (db.IS_POSTGRES) {
            console.log('[MIGRATION] Applying PostgreSQL additive changes...');
            await db.exec(`
                -- company_requirements updates
                ALTER TABLE ${companyReqTable} ADD COLUMN IF NOT EXISTS pay_per_mile_min DECIMAL;
                ALTER TABLE ${companyReqTable} ADD COLUMN IF NOT EXISTS pay_per_mile_max DECIMAL;
                ALTER TABLE ${companyReqTable} ADD COLUMN IF NOT EXISTS requires_travel_interview BOOLEAN DEFAULT FALSE;
                ALTER TABLE ${companyReqTable} ADD COLUMN IF NOT EXISTS home_time TEXT;
                ALTER TABLE ${companyReqTable} ADD COLUMN IF NOT EXISTS offered_freight_types TEXT;
                
                -- empresas updates
                ALTER TABLE ${empresasTable} ADD COLUMN IF NOT EXISTS company_logo TEXT;
                ALTER TABLE ${empresasTable} ADD COLUMN IF NOT EXISTS company_bio TEXT;
            `);
        } else {
            console.log('[MIGRATION] Applying SQLite additive changes (fallback)...');
            const addColumn = async (table, col, type) => {
                try {
                    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
                    console.log(`[MIGRATION] Added ${col} to ${table}`);
                } catch (e) {
                    if (e.message.includes('duplicate column name')) {
                        console.log(`[MIGRATION] ${col} already exists in ${table}`);
                    } else {
                        console.error(`[MIGRATION] Error adding ${col} to ${table}:`, e.message);
                    }
                }
            };

            await addColumn(companyReqTable, 'pay_per_mile_min', 'REAL');
            await addColumn(companyReqTable, 'pay_per_mile_max', 'REAL');
            await addColumn(companyReqTable, 'requires_travel_interview', 'BOOLEAN DEFAULT 0');
            await addColumn(companyReqTable, 'home_time', 'TEXT');
            await addColumn(companyReqTable, 'offered_freight_types', 'TEXT');

            await addColumn(empresasTable, 'company_logo', 'TEXT');
            await addColumn(empresasTable, 'company_bio', 'TEXT');
        }

        console.log('[MIGRATION] Phase 6 production schema hotfix completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('[MIGRATION] FATAL Error during hotfix migration:', err.message);
        process.exit(1);
    }
}

migrate();

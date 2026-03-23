const db = require('./db_adapter');

async function migrate() {
    console.log(`[MIGRATION] Starting Phase 6 Company Profile Update (Postgres: ${db.IS_POSTGRES})`);

    try {
        if (db.IS_POSTGRES) {
            await db.run('BEGIN');
        }

        console.log('[MIGRATION] Adding columns to empresas...');
        await db.run(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS company_logo TEXT`).catch(e => console.log('company_logo skip:', e.message));
        await db.run(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS company_bio TEXT`).catch(e => console.log('company_bio skip:', e.message));

        console.log('[MIGRATION] Adding columns to company_requirements...');
        // SQLite doesn't support IF NOT EXISTS in ALTER TABLE
        if (db.IS_POSTGRES) {
            await db.run(`ALTER TABLE company_requirements ADD COLUMN IF NOT EXISTS pay_per_mile_min NUMERIC`);
            await db.run(`ALTER TABLE company_requirements ADD COLUMN IF NOT EXISTS pay_per_mile_max NUMERIC`);
        } else {
            await db.run(`ALTER TABLE company_requirements ADD COLUMN pay_per_mile_min NUMERIC`).catch(e => console.log('pay_per_mile_min skip:', e.message));
            await db.run(`ALTER TABLE company_requirements ADD COLUMN pay_per_mile_max NUMERIC`).catch(e => console.log('pay_per_mile_max skip:', e.message));
        }

        if (db.IS_POSTGRES) {
            await db.run('COMMIT');
        }
        console.log('[MIGRATION] Phase 6 migration completed successfully');
    } catch (e) {
        if (db.IS_POSTGRES) {
            await db.run('ROLLBACK').catch(() => { });
        }
        console.error('[MIGRATION] Phase 6 migration failed:', e.message);
        process.exit(1);
    } finally {
        db.close();
    }
}

migrate();

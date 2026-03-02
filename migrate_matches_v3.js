require('dotenv').config();
const db = require('./db_adapter');

async function run() {
    try {
        console.log('Connected to DB via adapter');
        try {
            if (db.IS_POSTGRES) {
                await db.exec("ALTER TABLE potential_matches ADD COLUMN IF NOT EXISTS score_breakdown JSONB DEFAULT '{}'");
            } else {
                // SQLite doesn't have IF NOT EXISTS for ADD COLUMN in older versions or JSONB, we just use TEXT
                try {
                    await db.exec("ALTER TABLE potential_matches ADD COLUMN score_breakdown TEXT DEFAULT '{}'");
                } catch (e) {
                    if (!e.message.includes('duplicate column name')) throw e;
                }
            }
            console.log('Added score_breakdown column');
        } catch (e) {
            console.error('Error adding column:', e.message);
        }

        try {
            if (db.IS_POSTGRES) {
                await db.exec("ALTER TABLE potential_matches ADD CONSTRAINT uq_company_driver UNIQUE (company_id, driver_id)");
            } else {
                // SQLite unique constraint on existing table requires recreate, but we can try creating a unique index
                await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_company_driver ON potential_matches(company_id, driver_id)");
            }
            console.log('Added UNIQUE constraint/index');
        } catch (e) {
            if (e.code === '42P07' || e.message.includes('already exists')) {
                console.log('Constraint/index already exists');
            } else {
                throw e;
            }
        }
    } finally {
        if (db.close) db.close();
    }
}
run().catch(console.error);

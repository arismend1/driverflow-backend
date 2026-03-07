/**
 * Migration: Create lead_funnel_events table for acquisition analytics
 */
const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: lead_funnel_events ---');

    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS lead_funnel_events (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER NULL REFERENCES driver_leads(id) ON DELETE SET NULL,
                driver_id INTEGER NULL REFERENCES drivers(id) ON DELETE SET NULL,
                event_type TEXT NOT NULL,
                metadata_json JSONB NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        console.log('✅ TABLE lead_funnel_events created');

        await db.run(`CREATE INDEX IF NOT EXISTS idx_funnel_lead_id ON lead_funnel_events(lead_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_funnel_driver_id ON lead_funnel_events(driver_id)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_funnel_event_type ON lead_funnel_events(event_type)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_funnel_created_at ON lead_funnel_events(created_at DESC)`);
        console.log('✅ Indexes created for lead_funnel_events');

        console.log('✅ Funnel analytics migration complete');
    } catch (e) {
        console.error('❌ Migration failed:', e.message);
    }
    process.exit(0);
})();

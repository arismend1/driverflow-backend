/**
 * Migration: Add source + is_synthetic to driver_leads
 */
const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: driver_leads source/synthetic columns ---');

    const cols = [
        { name: 'source', sql: "ALTER TABLE driver_leads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'" },
        { name: 'is_synthetic', sql: "ALTER TABLE driver_leads ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false" },
    ];

    for (const { name, sql } of cols) {
        try {
            await db.run(sql);
            console.log(`✅ driver_leads.${name} added`);
        } catch (e) {
            if (e.message && (e.message.includes('already exists') || e.message.includes('duplicate column'))) {
                console.log(`⚠️ driver_leads.${name} already exists`);
            } else {
                console.error(`❌ driver_leads.${name}: ${e.message}`);
            }
        }
    }

    // Index for invite worker filtering
    try {
        await db.run(`CREATE INDEX IF NOT EXISTS idx_driver_leads_synthetic ON driver_leads(is_synthetic) WHERE is_synthetic = false`);
        console.log('✅ idx_driver_leads_synthetic OK');
    } catch (e) { console.error('Index error:', e.message); }

    console.log('✅ Source/synthetic migration complete');
    process.exit(0);
})();

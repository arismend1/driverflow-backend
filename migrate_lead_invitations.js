/**
 * Migration: Add invitation tracking columns to driver_leads
 */

const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: driver_leads invitation columns ---');

    const columns = [
        { name: 'invited_at', sql: 'ALTER TABLE driver_leads ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ' },
        { name: 'invite_count', sql: 'ALTER TABLE driver_leads ADD COLUMN IF NOT EXISTS invite_count INTEGER DEFAULT 0' },
    ];

    for (const { name, sql } of columns) {
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

    console.log('✅ Lead invitation migration complete');
    process.exit(0);
})();

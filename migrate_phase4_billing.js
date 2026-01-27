const db = require('./database');

try {
    console.log('--- Migrating: Phase 4 Billing MVP ---');

    const addCol = (table, col, def) => {
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!info.some(c => c.name === col)) {
            try {
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
                console.log(`✅ Added ${col} to ${table}`);
                return true;
            } catch (e) {
                console.log(`⚠️ Skip ${col} on ${table}: ${e.message}`);
            }
        }
        return false;
    };

    // 1. Ensure columns exist
    // Requirements: billing_status (exists but default check needed?), amount_cents, currency, paid_at, payment_ref, billing_notes
    // Current tickets: id, company_id, driver_id, request_id, price_cents, currency, billing_status, created_at

    // We strictly follow "amount_cents" requirement. We will use that moving forward.
    // We assume 'currency' and 'billing_status' exist but might need backfill.

    addCol('tickets', 'amount_cents', 'INTEGER DEFAULT 0');
    addCol('tickets', 'paid_at', 'TEXT');
    addCol('tickets', 'payment_ref', 'TEXT');
    addCol('tickets', 'billing_notes', 'TEXT');

    // 2. Backfill / Migration Logic
    const updates = db.transaction(() => {
        let count = 0;

        // A) Fix Status: 'unbilled' -> 'pending'
        // Also handle NULLs if any (schema has default 'unbilled' though)
        const resStatus = db.prepare(`
            UPDATE tickets 
            SET billing_status = 'pending' 
            WHERE billing_status IS NULL OR billing_status = 'unbilled'
        `).run();
        if (resStatus.changes > 0) console.log(`🔄 Updated ${resStatus.changes} tickets status to 'pending'`);

        // B) Backfill amount_cents from price_cents if amount_cents is 0 (default)
        // Check if price_cents exists just to be safe (it does based on my check)
        const resAmount = db.prepare(`
            UPDATE tickets 
            SET amount_cents = price_cents 
            WHERE (amount_cents IS NULL OR amount_cents = 0) AND price_cents > 0
        `).run();
        if (resAmount.changes > 0) console.log(`🔄 Backfilled ${resAmount.changes} tickets amount_cents from price_cents`);

        // C) Ensure Currency
        const resCurr = db.prepare(`
            UPDATE tickets
            SET currency = 'usd'
            WHERE currency IS NULL
        `).run();
        if (resCurr.changes > 0) console.log(`🔄 Set currency='usd' for ${resCurr.changes} tickets`);

    });

    updates();
    console.log('✅ Phase 4 Billing Migration Complete');

} catch (error) {
    console.error('❌ Error in Billing Migration:', error.message);
    process.exit(1);
}

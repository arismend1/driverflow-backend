const db = require('./db_adapter');

// Migration: Add payment reconciliation columns to tickets table
(async () => {
    console.log('--- Migrating: Ticket payment reconciliation columns ---');

    const columns = [
        { name: 'stripe_checkout_session_id', type: 'TEXT' },
        { name: 'stripe_payment_intent_id', type: 'TEXT' },
        { name: 'stripe_customer_id', type: 'TEXT' },
        { name: 'paid_at', type: 'TIMESTAMPTZ' }
    ];

    for (const col of columns) {
        try {
            await db.run(`ALTER TABLE tickets ADD COLUMN ${col.name} ${col.type}`);
            console.log(`✅ Added tickets.${col.name}`);
        } catch (e) {
            if (e.message.includes('already exists') || e.message.includes('duplicate column')) {
                console.log(`⚠️ tickets.${col.name} already exists`);
            } else {
                console.error(`❌ tickets.${col.name}:`, e.message);
            }
        }
    }

    console.log('✅ Migration complete');
    process.exit(0);
})();

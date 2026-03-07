const db = require('./db_adapter');

async function main() {
    console.log(`--- Wiping Database (via adapter) ---`);
    console.log(`Engine: ${db.IS_POSTGRES ? 'POSTGRES' : 'SQLITE'}`);

    const tables = [
        'ratings',
        'invoice_items',
        'invoices',
        'tickets',
        'potential_matches',
        'matches',
        'solicitudes',
        'company_match_prefs',
        'company_requirements',
        'driver_profiles',
        'events_outbox',
        'jobs_queue',
        'webhook_events',
        'stripe_webhook_events',
        'request_visibility',
        'user_match_generation_log',
        'drivers',
        'empresas'
    ];

    for (const table of tables) {
        try {
            console.log(`🧹 Wiping ${table}...`);
            await db.run(`DELETE FROM ${table}`);
            if (!db.IS_POSTGRES) {
                try {
                    await db.run(`DELETE FROM sqlite_sequence WHERE name=?`, table);
                } catch (e) { /* ignore if no sequence */ }
            }
        } catch (e) {
            console.log(`⚠️ Skipping ${table}: ${e.message}`);
        }
    }

    console.log('--- Database Wipe Complete ---');
    db.close();
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});

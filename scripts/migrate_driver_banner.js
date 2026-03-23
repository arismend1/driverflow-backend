const db = require('../db_adapter');

(async () => {
    console.log('--- [MIGRATION] DRIVER BANNER TABLE ---');
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS driver_banner (
                id SERIAL PRIMARY KEY,
                image_url TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ Success: driver_banner table created or already exists');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
})();

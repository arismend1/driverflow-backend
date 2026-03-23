const db = require('../db_adapter');

const imageUrl = process.argv[2];

if (!imageUrl) {
    console.log('Usage: node scripts/set_driver_banner.js <IMAGE_URL>');
    process.exit(1);
}

(async () => {
    console.log(`--- [ADMIN] SETTING DRIVER BANNER: ${imageUrl} ---`);
    try {
        // 1. Deactivate all
        await db.run('UPDATE driver_banner SET is_active = false');
        
        // 2. Insert new
        await db.run('INSERT INTO driver_banner (image_url, is_active) VALUES (?, true)', imageUrl);
        
        console.log('✅ Driver banner updated successfully');
        process.exit(0);
    } catch (err) {
        console.error('❌ Failed to update banner:', err.message);
        process.exit(1);
    }
})();

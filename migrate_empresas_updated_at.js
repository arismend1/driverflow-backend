/**
 * Migration: Add updated_at column to empresas table
 * 
 * Problem: server.js writes updated_at to empresas (admin reject, unsuspend)
 * but the column doesn't exist in the production schema.
 * 
 * This migration is idempotent (IF NOT EXISTS).
 */
require('dotenv').config();
const db = require('./db_adapter');

async function migrate() {
    console.log('[migrate_empresas_updated_at] Starting...');

    try {
        if (db.IS_POSTGRES) {
            await db.run(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS updated_at TEXT`);
        } else {
            // SQLite: no IF NOT EXISTS for ALTER TABLE, so try/catch
            try {
                await db.run(`ALTER TABLE empresas ADD COLUMN updated_at TEXT`);
            } catch (e) {
                if (e.message && e.message.includes('duplicate column')) {
                    console.log('[migrate_empresas_updated_at] Column already exists (SQLite). OK.');
                } else {
                    throw e;
                }
            }
        }

        console.log('[migrate_empresas_updated_at] ✅ updated_at column ensured on empresas.');
    } catch (e) {
        console.error('[migrate_empresas_updated_at] ❌ Error:', e.message);
        throw e;
    }
}

migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));

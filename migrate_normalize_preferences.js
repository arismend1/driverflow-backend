/**
 * Migration: Normalize multi-value preference columns into bridge tables
 *
 * Creates 12 bridge tables (6 driver, 6 company), 8 B-tree indexes,
 * and backfills data from legacy TEXT/JSONB columns.
 *
 * Safe: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.
 */

const db = require('./db_adapter');

// ─── Helpers ────────────────────────────────────────────────────────────────

function toArray(val) {
    if (!val) return [];

    // Si ya viene de Postgres como Array JSONB
    if (Array.isArray(val)) return val.map(x => String(x).trim().toLowerCase()).filter(Boolean);

    if (typeof val === 'string') {
        const s = val.trim();
        // Si parece un array o dict JSON
        if (s.startsWith('[') || s.startsWith('{')) {
            try {
                // Forzar arreglo si venía como set '{}'
                const parsed = JSON.parse(s.replace(/^\{/, '[').replace(/\}$/, ']'));
                if (Array.isArray(parsed)) return parsed.map(x => String(x).trim().toLowerCase()).filter(Boolean);
            } catch (_) {
                // Parsing falló (sintaxis inválida heredada). Caer directo a la separación por comas.
            }
        }

        // Fallback robusto CSV para la mugre de la tabla vieja
        return s.replace(/[\[\]{}\"]/g, '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    }

    return [String(val).trim().toLowerCase()].filter(Boolean);
}

(async () => {
    console.log('--- Migrating: Normalize preferences into bridge tables ---');

    // ═════════════════════════════════════════════════════════════════════
    // PHASE A: CREATE TABLES
    // ═════════════════════════════════════════════════════════════════════

    const bridgeTables = [
        // Driver tables
        { name: 'driver_operation_types', fk: 'driver_id', ref: 'drivers' },
        { name: 'driver_license_types', fk: 'driver_id', ref: 'drivers' },
        { name: 'driver_endorsements', fk: 'driver_id', ref: 'drivers' },
        { name: 'driver_payment_methods', fk: 'driver_id', ref: 'drivers' },
        { name: 'driver_work_relationships', fk: 'driver_id', ref: 'drivers' },
        { name: 'driver_job_preferences', fk: 'driver_id', ref: 'drivers' },
        // Company tables
        { name: 'company_req_operation_types', fk: 'company_id', ref: 'empresas' },
        { name: 'company_req_license_types', fk: 'company_id', ref: 'empresas' },
        { name: 'company_req_endorsements', fk: 'company_id', ref: 'empresas' },
        { name: 'company_req_modalities', fk: 'company_id', ref: 'empresas' },
        { name: 'company_offered_payment_methods', fk: 'company_id', ref: 'empresas' },
        { name: 'company_req_relationships', fk: 'company_id', ref: 'empresas' },
    ];

    for (const { name, fk, ref } of bridgeTables) {
        try {
            await db.run(`
                CREATE TABLE IF NOT EXISTS ${name} (
                    ${fk}   INTEGER NOT NULL REFERENCES ${ref}(id) ON DELETE CASCADE,
                    value   TEXT    NOT NULL CHECK (value <> ''),
                    PRIMARY KEY (${fk}, value)
                )
            `);
            console.log(`✅ Table ${name} created`);
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                console.log(`⚠️ Table ${name} already exists`);
            } else {
                console.error(`❌ Table ${name}: ${e.message}`);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // PHASE A.2: CREATE INDEXES
    // ═════════════════════════════════════════════════════════════════════

    const indexes = [
        // Driver bridge indexes (value, driver_id) for EXISTS lookups
        'CREATE INDEX IF NOT EXISTS idx_dot_value  ON driver_operation_types(value, driver_id)',
        'CREATE INDEX IF NOT EXISTS idx_dlt_value  ON driver_license_types(value, driver_id)',
        'CREATE INDEX IF NOT EXISTS idx_de_value   ON driver_endorsements(value, driver_id)',
        'CREATE INDEX IF NOT EXISTS idx_dpm_value  ON driver_payment_methods(value, driver_id)',
        // Company bridge indexes (value, company_id) for EXISTS lookups
        'CREATE INDEX IF NOT EXISTS idx_crot_value ON company_req_operation_types(value, company_id)',
        'CREATE INDEX IF NOT EXISTS idx_crlt_value ON company_req_license_types(value, company_id)',
        'CREATE INDEX IF NOT EXISTS idx_cre_value  ON company_req_endorsements(value, company_id)',
        'CREATE INDEX IF NOT EXISTS idx_copm_value ON company_offered_payment_methods(value, company_id)',
    ];

    for (const sql of indexes) {
        try {
            await db.run(sql);
            const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
            console.log(`✅ Index ${name} OK`);
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                console.log(`⚠️ Index already exists`);
            } else {
                console.error(`❌ Index error: ${e.message}`);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // PHASE B: BACKFILL from legacy columns
    // ═════════════════════════════════════════════════════════════════════
    console.log('--- Phase B: Backfilling bridge tables from legacy columns ---');

    // Driver backfill mappings: { table, fk, sourceTable, sourceColumn }
    const driverBackfills = [
        { table: 'driver_operation_types', col: 'operation_types' },
        { table: 'driver_license_types', col: 'license_types' },
        { table: 'driver_endorsements', col: 'endorsements' },
        { table: 'driver_payment_methods', col: 'payment_methods' },
        { table: 'driver_work_relationships', col: 'work_relationships' },
        { table: 'driver_job_preferences', col: 'job_preferences' },
    ];

    for (const { table, col } of driverBackfills) {
        try {
            const rows = await db.all(
                `SELECT id, ${col} FROM drivers WHERE ${col} IS NOT NULL AND ${col} <> ''`
            );
            let insertCount = 0;
            let skipCount = 0;
            for (const row of rows) {
                let raw = row[col];
                if (typeof raw === 'object' && raw !== null) {
                    raw = JSON.stringify(raw);
                }
                const values = toArray(raw);
                if (values.length === 0) {
                    skipCount++;
                }

                for (const v of values) {
                    try {
                        await db.run(
                            `INSERT INTO ${table} (driver_id, value) VALUES (?, ?) ON CONFLICT DO NOTHING`,
                            row.id, v
                        );
                        insertCount++;
                    } catch (_) { /* ON CONFLICT fallback */ }
                }
            }
            console.log(`✅ Backfill ${table}: ${insertCount} values inserted, ${skipCount} skipped rows, from ${rows.length} total drivers`);
        } catch (e) {
            console.error(`❌ Backfill ${table}: ${e.message}`);
        }
    }

    // Company backfill mappings
    const companyBackfills = [
        { table: 'company_req_operation_types', col: 'req_operation_types' },
        { table: 'company_req_license_types', col: 'req_license_types' },
        { table: 'company_req_endorsements', col: 'req_endorsements' },
        { table: 'company_req_modalities', col: 'req_modalities' },
        { table: 'company_offered_payment_methods', col: 'offered_payment_methods' },
        { table: 'company_req_relationships', col: 'req_relationships' },
    ];

    for (const { table, col } of companyBackfills) {
        try {
            const rows = await db.all(
                `SELECT company_id, ${col} FROM company_requirements WHERE ${col} IS NOT NULL`
            );
            let insertCount = 0;
            let skipCount = 0;
            for (const row of rows) {
                let raw = row[col];
                // Handle JSONB (Postgres returns parsed object/array)
                if (typeof raw === 'object' && raw !== null) {
                    raw = JSON.stringify(raw);
                }
                const values = toArray(raw);
                if (values.length === 0) {
                    skipCount++;
                }

                for (const v of values) {
                    try {
                        await db.run(
                            `INSERT INTO ${table} (company_id, value) VALUES (?, ?) ON CONFLICT DO NOTHING`,
                            row.company_id, v
                        );
                        insertCount++;
                    } catch (_) { /* ON CONFLICT fallback */ }
                }
            }
            console.log(`✅ Backfill ${table}: ${insertCount} values inserted, ${skipCount} skipped rows, from ${rows.length} total companies`);
        } catch (e) {
            console.error(`❌ Backfill ${table}: ${e.message}`);
        }
    }

    console.log('✅ Preference normalization migration complete');
    process.exit(0);
})();

const REACTIVATION_TABLE = 'driver_reactivation_requests';
const DRIVER_INDEX = 'idx_driver_reactivation_driver';
const COMPANY_INDEX = 'idx_driver_reactivation_company';
const MATCH_INDEX = 'idx_driver_reactivation_match';
const PENDING_UNIQUE_INDEX = 'uq_driver_reactivation_pending_match';

const schemaStateCache = new WeakMap();
const compatibilityBootstrapCache = new WeakMap();
const warningCache = new WeakMap();

function getWarningSet(db) {
    if (!warningCache.has(db)) {
        warningCache.set(db, new Set());
    }
    return warningCache.get(db);
}

function warnOnce(db, key, logger, message) {
    const warnings = getWarningSet(db);
    if (warnings.has(key)) return;
    warnings.add(key);
    logger.warn(message);
}

function clearDriverReactivationSchemaState(db) {
    schemaStateCache.delete(db);
}

async function getDriverReactivationSchemaState(db, runner = db) {
    const cached = schemaStateCache.get(db);
    if (cached) return cached;

    let tableAvailable = false;
    let pendingUniqueIndexAvailable = false;

    if (db.IS_POSTGRES) {
        const tableRow = await runner.get(`
            SELECT 1 AS ok
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ?
            LIMIT 1
        `, REACTIVATION_TABLE);
        tableAvailable = !!tableRow;

        if (tableAvailable) {
            const indexRow = await runner.get(`
                SELECT 1 AS ok
                FROM pg_indexes
                WHERE schemaname = 'public'
                  AND tablename = ?
                  AND indexname = ?
                LIMIT 1
            `, REACTIVATION_TABLE, PENDING_UNIQUE_INDEX);
            pendingUniqueIndexAvailable = !!indexRow;
        }
    } else {
        const tableRow = await runner.get(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name = ?
            LIMIT 1
        `, REACTIVATION_TABLE);
        tableAvailable = !!tableRow;

        if (tableAvailable) {
            const indexRow = await runner.get(`
                SELECT name
                FROM sqlite_master
                WHERE type = 'index'
                  AND name = ?
                LIMIT 1
            `, PENDING_UNIQUE_INDEX);
            pendingUniqueIndexAvailable = !!indexRow;
        }
    }

    const state = {
        tableAvailable,
        pendingUniqueIndexAvailable,
        requestCreationAvailable: tableAvailable && pendingUniqueIndexAvailable
    };
    schemaStateCache.set(db, state);
    return state;
}

async function hasDriverReactivationTable(db, runner = db) {
    return (await getDriverReactivationSchemaState(db, runner)).tableAvailable;
}

async function canCreateDriverReactivationRequests(db, runner = db) {
    return (await getDriverReactivationSchemaState(db, runner)).requestCreationAvailable;
}

// Temporary startup-only compatibility bridge. Request paths must never call this.
async function runDriverReactivationStartupCompatibilityBootstrap(db, logger = console) {
    const existing = compatibilityBootstrapCache.get(db);
    if (existing) return existing;

    const promise = (async () => {
        if ((process.env.DRIVER_REACTIVATION_RUNTIME_SCHEMA_COMPAT || 'true') === 'false') {
            warnOnce(
                db,
                'driver-reactivation-compat-disabled',
                logger,
                '[Driver Reactivation] Startup compatibility bootstrap disabled; expecting schema migration to exist already.'
            );
            return getDriverReactivationSchemaState(db);
        }

        const currentState = await getDriverReactivationSchemaState(db);
        if (currentState.requestCreationAvailable) {
            return currentState;
        }

        warnOnce(
            db,
            'driver-reactivation-compat-bootstrap',
            logger,
            '[Driver Reactivation] Applying isolated startup-only compatibility bootstrap for driver_reactivation_requests.'
        );

        if (!currentState.tableAvailable) {
            if (db.IS_POSTGRES) {
                await db.run(`
                    CREATE TABLE IF NOT EXISTS driver_reactivation_requests (
                        id BIGSERIAL PRIMARY KEY,
                        driver_id INTEGER NOT NULL,
                        company_id INTEGER NOT NULL,
                        match_id INTEGER,
                        status TEXT NOT NULL,
                        requested_at TEXT NOT NULL,
                        responded_at TEXT,
                        company_response TEXT,
                        driver_notes TEXT,
                        company_notes TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                `);
            } else {
                await db.run(`
                    CREATE TABLE IF NOT EXISTS driver_reactivation_requests (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        driver_id INTEGER NOT NULL,
                        company_id INTEGER NOT NULL,
                        match_id INTEGER,
                        status TEXT NOT NULL,
                        requested_at TEXT NOT NULL,
                        responded_at TEXT,
                        company_response TEXT,
                        driver_notes TEXT,
                        company_notes TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                `);
            }
        }

        await db.run(`CREATE INDEX IF NOT EXISTS ${DRIVER_INDEX} ON ${REACTIVATION_TABLE}(driver_id, requested_at)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${COMPANY_INDEX} ON ${REACTIVATION_TABLE}(company_id, status, requested_at)`);
        await db.run(`CREATE INDEX IF NOT EXISTS ${MATCH_INDEX} ON ${REACTIVATION_TABLE}(match_id, requested_at)`);
        await db.run(`
            CREATE UNIQUE INDEX IF NOT EXISTS ${PENDING_UNIQUE_INDEX}
            ON ${REACTIVATION_TABLE}(driver_id, company_id, match_id)
            WHERE status = 'pending_company_confirmation'
        `);

        clearDriverReactivationSchemaState(db);
        return getDriverReactivationSchemaState(db);
    })().catch((err) => {
        compatibilityBootstrapCache.delete(db);
        clearDriverReactivationSchemaState(db);
        throw err;
    });

    compatibilityBootstrapCache.set(db, promise);
    return promise;
}

function isPendingReactivationDuplicateError(error) {
    if (!error) return false;

    if (error.code === '23505') {
        return error.constraint === PENDING_UNIQUE_INDEX
            || String(error.message || '').includes(PENDING_UNIQUE_INDEX);
    }

    if (error.code === 'SQLITE_CONSTRAINT' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const message = String(error.message || '');
        return message.includes(PENDING_UNIQUE_INDEX)
            || message.includes(`${REACTIVATION_TABLE}.driver_id`)
            || message.includes('UNIQUE constraint failed');
    }

    return false;
}

async function getLastHiredMatchForDriver(db, driverId, runner = db) {
    if (!driverId) return null;

    return runner.get(`
        SELECT
            pm.id AS match_id,
            pm.driver_id,
            pm.company_id,
            pm.status,
            pm.created_at,
            pm.updated_at,
            e.nombre AS company_name
        FROM potential_matches pm
        LEFT JOIN empresas e ON e.id = pm.company_id
        WHERE pm.driver_id = ?
          AND pm.status = 'HIRED'
        ORDER BY COALESCE(pm.updated_at, pm.created_at) DESC, pm.id DESC
        LIMIT 1
    `, driverId);
}

async function getLatestReactivationRequestForDriver(db, driverId, runner = db) {
    if (!driverId) return null;
    if (!(await hasDriverReactivationTable(db, runner))) return null;

    return runner.get(`
        SELECT
            id,
            driver_id,
            company_id,
            match_id,
            status,
            requested_at,
            responded_at,
            company_response,
            driver_notes,
            company_notes,
            created_at,
            updated_at
        FROM driver_reactivation_requests
        WHERE driver_id = ?
        ORDER BY COALESCE(updated_at, requested_at, created_at) DESC, id DESC
        LIMIT 1
    `, driverId);
}

async function getLatestReactivationRequestForMatch(db, driverId, companyId, matchId, runner = db) {
    if (!driverId || !companyId) return null;
    if (!(await hasDriverReactivationTable(db, runner))) return null;

    const params = [driverId, companyId];
    let matchSql = '';
    if (matchId !== null && matchId !== undefined) {
        matchSql = 'AND match_id = ?';
        params.push(matchId);
    }

    return runner.get(`
        SELECT
            id,
            driver_id,
            company_id,
            match_id,
            status,
            requested_at,
            responded_at,
            company_response,
            driver_notes,
            company_notes,
            created_at,
            updated_at
        FROM driver_reactivation_requests
        WHERE driver_id = ?
          AND company_id = ?
          ${matchSql}
        ORDER BY COALESCE(updated_at, requested_at, created_at) DESC, id DESC
        LIMIT 1
    `, ...params);
}

async function getPendingReactivationRequestForMatch(db, driverId, companyId, matchId, runner = db) {
    if (!driverId || !companyId) return null;
    if (!(await hasDriverReactivationTable(db, runner))) return null;

    const params = [driverId, companyId];
    let matchSql = '';
    if (matchId !== null && matchId !== undefined) {
        matchSql = 'AND match_id = ?';
        params.push(matchId);
    }

    return runner.get(`
        SELECT
            id,
            driver_id,
            company_id,
            match_id,
            status,
            requested_at,
            responded_at,
            company_response,
            driver_notes,
            company_notes,
            created_at,
            updated_at
        FROM driver_reactivation_requests
        WHERE driver_id = ?
          AND company_id = ?
          ${matchSql}
          AND status = 'pending_company_confirmation'
        ORDER BY COALESCE(updated_at, requested_at, created_at) DESC, id DESC
        LIMIT 1
    `, ...params);
}

async function getDriverReactivationContext(db, driverId, runner = db) {
    const schemaState = await getDriverReactivationSchemaState(db, runner);
    const lastHire = await getLastHiredMatchForDriver(db, driverId, runner);

    if (!lastHire) {
        const latestRequest = schemaState.tableAvailable
            ? await getLatestReactivationRequestForDriver(db, driverId, runner)
            : null;
        return {
            tableAvailable: schemaState.tableAvailable,
            featureAvailable: schemaState.requestCreationAvailable,
            lastHire: null,
            latestRequest,
            isCurrentlyHired: false,
            canRequestReactivation: false,
            reactivationStatus: latestRequest?.status || null
        };
    }

    const latestRequest = await getLatestReactivationRequestForMatch(
        db,
        driverId,
        lastHire.company_id,
        lastHire.match_id,
        runner
    );

    const reactivationStatus = latestRequest?.status || null;
    const pending = reactivationStatus === 'pending_company_confirmation';
    const denied = reactivationStatus === 'denied_by_company';

    return {
        tableAvailable: schemaState.tableAvailable,
        featureAvailable: schemaState.requestCreationAvailable,
        lastHire,
        latestRequest,
        isCurrentlyHired: true,
        canRequestReactivation: schemaState.requestCreationAvailable && !pending && !denied,
        reactivationStatus
    };
}

async function closePriorEmploymentRelationship(db, matchId, nowIsoValue, runner = db) {
    if (!matchId) return false;

    const result = await runner.run(`
        UPDATE potential_matches
        SET status = 'CLOSED',
            resolution_company = COALESCE(resolution_company, 'HIRED'),
            resolution_driver = COALESCE(resolution_driver, 'HIRED'),
            updated_at = ?
        WHERE id = ?
          AND status = 'HIRED'
    `, nowIsoValue, matchId);

    return !!((typeof result?.changes === 'number' && result.changes > 0) || (typeof result?.rowCount === 'number' && result.rowCount > 0));
}

module.exports = {
    getDriverReactivationSchemaState,
    hasDriverReactivationTable,
    canCreateDriverReactivationRequests,
    runDriverReactivationStartupCompatibilityBootstrap,
    isPendingReactivationDuplicateError,
    getLastHiredMatchForDriver,
    getLatestReactivationRequestForDriver,
    getLatestReactivationRequestForMatch,
    getPendingReactivationRequestForMatch,
    getDriverReactivationContext,
    closePriorEmploymentRelationship
};

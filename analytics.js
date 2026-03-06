const db = require('./db_adapter');

/**
 * Registra eventos en el funnel de adquisición de drivers de forma segura
 * No rompe la ejecución si ocurre algún error de base de datos
 */
async function trackLeadFunnelEvent(eventType, { lead_id = null, driver_id = null, company_id = null, metadata = {} } = {}) {
    try {
        let metaVal = metadata;
        if (!db.IS_POSTGRES) {
            // SQLite expects strings for JSON columns typically
            metaVal = typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
        } else {
            // Postgres node-pg usually stringifies JSONB parameters automatically, or we pass it stringified
            metaVal = typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
        }

        const query = `
            INSERT INTO lead_funnel_events (lead_id, driver_id, company_id, event_type, metadata)
            VALUES (?, ?, ?, ?, ?)
        `;

        await db.run(query, lead_id, driver_id, company_id, eventType, metaVal);

        console.log(`[LeadFunnel] event=${eventType}` +
            (lead_id ? ` lead_id=${lead_id}` : '') +
            (driver_id ? ` driver_id=${driver_id}` : '') +
            (company_id ? ` company_id=${company_id}` : '')
        );
    } catch (e) {
        console.warn(`[LeadFunnel] WARNING: Error tracking event ${eventType}: ${e.message}`);
    }
}

module.exports = { trackLeadFunnelEvent };

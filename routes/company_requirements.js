const express = require('express');
const router = express.Router();
const db = require('../db');
// const { requireCompany } = require('../middleware/auth');

// GET /companies/requirements
router.get('/', (req, res) => {
    const companyId = req.user ? req.user.id : null;
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });

    const reqs = db.prepare('SELECT * FROM company_requirements WHERE company_id = ?').get(companyId);

    if (reqs) {
        ['req_license_types', 'req_endorsements', 'req_operation_types', 'req_modalities',
            'offered_payment_methods', 'req_relationships', 'req_experience_range'].forEach(field => {
                try { reqs[field] = JSON.parse(reqs[field]); } catch (e) { reqs[field] = []; }
            });
    }

    res.json(reqs || {});
});

// PUT /companies/requirements
router.put('/', (req, res) => {
    const companyId = req.user ? req.user.id : null;
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });

    const {
        req_cdl, req_license_types, req_endorsements, req_operation_types,
        req_experience_range, req_modalities, req_truck,
        offered_payment_methods, req_relationships, availability
    } = req.body;

    const now = new Date().toISOString();

    const exists = db.prepare('SELECT 1 FROM company_requirements WHERE company_id = ?').get(companyId);

    if (exists) {
        db.prepare(`
            UPDATE company_requirements SET
                req_cdl = ?, req_license_types = ?, req_endorsements = ?, req_operation_types = ?,
                req_experience_range = ?, req_modalities = ?, req_truck = ?,
                offered_payment_methods = ?, req_relationships = ?, availability = ?, updated_at = ?
            WHERE company_id = ?
        `).run(
            req_cdl ? 1 : 0, JSON.stringify(req_license_types), JSON.stringify(req_endorsements), JSON.stringify(req_operation_types),
            JSON.stringify(req_experience_range), JSON.stringify(req_modalities), req_truck ? 1 : 0,
            JSON.stringify(offered_payment_methods), JSON.stringify(req_relationships), availability, now,
            companyId
        );
    } else {
        db.prepare(`
            INSERT INTO company_requirements (
                company_id, req_cdl, req_license_types, req_endorsements, req_operation_types,
                req_experience_range, req_modalities, req_truck,
                offered_payment_methods, req_relationships, availability, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            companyId, req_cdl ? 1 : 0, JSON.stringify(req_license_types), JSON.stringify(req_endorsements), JSON.stringify(req_operation_types),
            JSON.stringify(req_experience_range), JSON.stringify(req_modalities), req_truck ? 1 : 0,
            JSON.stringify(offered_payment_methods), JSON.stringify(req_relationships), availability, now
        );
    }

    res.json({ success: true });
});

module.exports = router;

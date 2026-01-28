const express = require('express');
const router = express.Router();
const db = require('../db');
// const { requireDriver } = require('../middleware/auth'); 

// GET /drivers/profile
router.get('/', (req, res) => {
    // Assuming auth middleware adds req.user or req.driverId
    const driverId = req.user ? req.user.id : null;
    if (!driverId) return res.status(401).json({ error: 'Unauthorized' });

    const profile = db.prepare('SELECT * FROM driver_profiles WHERE driver_id = ?').get(driverId);

    // Parse JSON fields for client
    if (profile) {
        ['license_types', 'endorsements', 'operation_types', 'job_preferences',
            'payment_methods', 'work_relationships'].forEach(field => {
                try { profile[field] = JSON.parse(profile[field]); } catch (e) { profile[field] = []; }
            });
    }

    res.json(profile || {});
});

// PUT /drivers/profile
router.put('/', (req, res) => {
    const driverId = req.user ? req.user.id : null;
    if (!driverId) return res.status(401).json({ error: 'Unauthorized' });

    const {
        has_cdl, license_types, endorsements, operation_types,
        experience_years, experience_range, job_preferences,
        has_truck, payment_methods, work_relationships
    } = req.body;

    const now = new Date().toISOString();

    // Check if exists
    const exists = db.prepare('SELECT 1 FROM driver_profiles WHERE driver_id = ?').get(driverId);

    if (exists) {
        db.prepare(`
            UPDATE driver_profiles SET
                has_cdl = ?, license_types = ?, endorsements = ?, operation_types = ?,
                experience_years = ?, experience_range = ?, job_preferences = ?,
                has_truck = ?, payment_methods = ?, work_relationships = ?, updated_at = ?
            WHERE driver_id = ?
        `).run(
            has_cdl ? 1 : 0, JSON.stringify(license_types), JSON.stringify(endorsements), JSON.stringify(operation_types),
            experience_years, experience_range, JSON.stringify(job_preferences),
            has_truck ? 1 : 0, JSON.stringify(payment_methods), JSON.stringify(work_relationships), now,
            driverId
        );
    } else {
        db.prepare(`
            INSERT INTO driver_profiles (
                driver_id, has_cdl, license_types, endorsements, operation_types,
                experience_years, experience_range, job_preferences,
                has_truck, payment_methods, work_relationships, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            driverId, has_cdl ? 1 : 0, JSON.stringify(license_types), JSON.stringify(endorsements), JSON.stringify(operation_types),
            experience_years, experience_range, JSON.stringify(job_preferences),
            has_truck ? 1 : 0, JSON.stringify(payment_methods), JSON.stringify(work_relationships), now
        );
    }

    res.json({ success: true });
});

module.exports = router;

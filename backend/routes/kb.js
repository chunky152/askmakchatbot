const router = require('express').Router();
<<<<<<< HEAD
const db = require('../config/db');

router.get('/categories', async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT DISTINCT category FROM documents WHERE category IS NOT NULL AND category != '' ORDER BY category ASC`
=======
const rateLimit = require('express-rate-limit');
const db = require('../config/db');

const kbLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false
});

const ticketLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many ticket submissions, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: false
});

/** GET /api/kb/categories — distinct published categories */
router.get('/categories', kbLimiter, async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT DISTINCT category FROM kb_entries WHERE is_published = TRUE ORDER BY category`
>>>>>>> 066befb2c63deab9f3da5a0f570833ebcbeaeb58
        );
        res.json({ categories: result.rows.map(r => r.category) });
    } catch (err) {
        next(err);
    }
});

<<<<<<< HEAD
router.get('/categories/:category/titles', async (req, res, next) => {
    try {
        const { category } = req.params;
        const result = await db.query(
            `SELECT id, title FROM documents WHERE category = $1 ORDER BY title ASC`,
            [category]
        );
        res.json({ titles: result.rows });
=======
/** GET /api/kb/categories/:category — all published titles in a category */
router.get('/categories/:category', kbLimiter, async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT id, title FROM kb_entries
             WHERE category = $1 AND is_published = TRUE
             ORDER BY title`,
            [req.params.category]
        );
        res.json({ entries: result.rows });
>>>>>>> 066befb2c63deab9f3da5a0f570833ebcbeaeb58
    } catch (err) {
        next(err);
    }
});

<<<<<<< HEAD
router.get('/documents/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await db.query(
            `SELECT id, title, content, category FROM documents WHERE id = $1`,
            [id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });
        res.json({ document: result.rows[0] });
=======
/** GET /api/kb/entries/:id — full content of a single published entry */
router.get('/entries/:id', kbLimiter, async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT id, category, title, content FROM kb_entries
             WHERE id = $1 AND is_published = TRUE`,
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ entry: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

/** POST /api/kb/tickets — submit a support ticket (student must be logged in, but we accept email too) */
router.post('/tickets', ticketLimiter, async (req, res, next) => {
    try {
        const { category, title, student_email, student_name } = req.body;
        if (!category || !title || !student_email) {
            return res.status(400).json({ error: 'category, title, and student_email are required' });
        }
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRe.test(student_email)) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        const result = await db.query(
            `INSERT INTO kb_tickets (category, title, student_email, student_name)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [
                category.trim().substring(0, 100),
                title.trim().substring(0, 512),
                student_email.trim().toLowerCase(),
                (student_name || '').trim().substring(0, 255) || null
            ]
        );
        res.status(201).json({
            id: result.rows[0].id,
            message: 'Ticket submitted successfully. You will be notified by email when it is resolved.'
        });
>>>>>>> 066befb2c63deab9f3da5a0f570833ebcbeaeb58
    } catch (err) {
        next(err);
    }
});

module.exports = router;

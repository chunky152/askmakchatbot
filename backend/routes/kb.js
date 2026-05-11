const router = require('express').Router();
const db = require('../config/db');

router.get('/categories', async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT DISTINCT category FROM documents WHERE category IS NOT NULL AND category != '' ORDER BY category ASC`
        );
        res.json({ categories: result.rows.map(r => r.category) });
    } catch (err) {
        next(err);
    }
});

router.get('/categories/:category/titles', async (req, res, next) => {
    try {
        const { category } = req.params;
        const result = await db.query(
            `SELECT id, title FROM documents WHERE category = $1 ORDER BY title ASC`,
            [category]
        );
        res.json({ titles: result.rows });
    } catch (err) {
        next(err);
    }
});

router.get('/documents/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await db.query(
            `SELECT id, title, content, category FROM documents WHERE id = $1`,
            [id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });
        res.json({ document: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

module.exports = router;

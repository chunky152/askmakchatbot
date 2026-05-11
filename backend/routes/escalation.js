const router = require('express').Router();
const db = require('../config/db');
const { optionalAuth, requireAuth, requireAdmin } = require('../middleware/auth');

router.post('/', optionalAuth, async (req, res, next) => {
    try {
        const { chat_id, message_id, reason, user_email, category, title } = req.body;
        
        if (!chat_id && !message_id) {
            if (!user_email || !category || !title) {
                return res.status(400).json({ error: 'user_email, category, and title required for formal tickets' });
            }
            const result = await db.query(
                `INSERT INTO escalations (user_email, category, title, reason)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [user_email, category, title, reason || 'Knowledge base query escalation']
            );
            return res.status(201).json(result.rows[0]);
        }

        if (!chat_id || !message_id) {
            return res.status(400).json({ error: 'chat_id and message_id required' });
        }

        const result = await db.query(
            `INSERT INTO escalations (chat_id, message_id, reason)
             VALUES ($1, $2, $3) RETURNING *`,
            [chat_id, message_id, reason || null]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        let sql = `
            SELECT e.*, c.title as chat_title, m.content as message_content,
                   u.full_name as user_name
            FROM escalations e
            JOIN chats c ON c.id = e.chat_id
            JOIN messages m ON m.id = e.message_id
            LEFT JOIN users u ON u.id = c.user_id
        `;
        const params = [];
        let paramIdx = 1;

        if (status) {
            sql += ` WHERE e.status = $${paramIdx}`;
            params.push(status);
            paramIdx++;
        }

        sql += ` ORDER BY e.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(sql, params);

        const countSql = status
            ? 'SELECT COUNT(*) FROM escalations WHERE status = $1'
            : 'SELECT COUNT(*) FROM escalations';
        const countResult = await db.query(countSql, status ? [status] : []);

        res.json({
            escalations: result.rows,
            total: parseInt(countResult.rows[0].count),
            page: parseInt(page),
            limit: parseInt(limit)
        });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
        const { status, admin_response } = req.body;
        if (!status) return res.status(400).json({ error: 'Status required' });

        const updates = ['status = $1', 'resolved_at = CASE WHEN $1 = \'resolved\' THEN NOW() ELSE resolved_at END'];
        const params = [status];
        let paramIdx = 2;

        if (admin_response) {
            updates.push(`admin_response = $${paramIdx}`);
            params.push(admin_response);
            paramIdx++;
        }

        params.push(req.params.id);
        const result = await db.query(
            `UPDATE escalations SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
            params
        );

        if (!result.rows.length) return res.status(404).json({ error: 'Escalation not found' });

        if (admin_response) {
            const esc = result.rows[0];
            await db.query(
                `INSERT INTO messages (chat_id, role, content)
                 VALUES ($1, 'system', $2)`,
                [esc.chat_id, 'Staff response: ' + admin_response]
            );
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

module.exports = router;

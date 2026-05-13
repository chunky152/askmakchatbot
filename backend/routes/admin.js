const router = require('express').Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../config/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { adminLimiter } = require('../middleware/rateLimit');
const storage = require('../services/storage');
const { generateEmbedding, generateEmbeddings } = require('../services/embedding');
const { chunkText } = require('../services/scraper');
const { getToolSchemas } = require('../services/mcp/registry');
const emailService = require('../services/email');

const DOC_BUCKET = process.env.MINIO_BUCKET_DOCUMENTS || 'documents';
const REF_BUCKET = process.env.MINIO_BUCKET_REFERENCE || 'reference';
const UP_BUCKET = process.env.MINIO_BUCKET_UPLOADS || 'uploads';

const MIN_KB_CHUNK_WORDS = Math.max(4, parseInt(process.env.INGEST_MIN_CHUNK_WORDS || '10', 10));

function wordCountKb(s) {
    return (s || '').split(/\s+/).filter(Boolean).length;
}

function kbEntryDocumentSourceUrl(entryId) {
    return 'kb-entry://' + String(entryId).trim();
}

async function removeKbSyncedDocuments(entryId) {
    await db.query(`DELETE FROM documents WHERE source_url = $1`, [kbEntryDocumentSourceUrl(entryId)]);
}

/**
 * Keep vector index aligned with a curated kb_entries row (Option A dual-store).
 * Published → replace all chunks for kb-entry://id; draft → remove chunks.
 */
async function syncKbEntryDocuments(entry) {
    const id = entry.id;
    await removeKbSyncedDocuments(id);
    if (!entry.is_published) {
        return { ok: true, chunks: 0, mode: 'cleared_draft' };
    }
    const category = String(entry.category || 'faq').trim() || 'faq';
    const title = String(entry.title || '').trim();
    const body = String(entry.content || '').trim();
    if (!title || !body) {
        return { ok: false, chunks: 0, error: 'missing_title_or_content' };
    }
    const full = title + '\n\n' + body;
    let chunks = chunkText(full).filter((c) => wordCountKb(c) >= MIN_KB_CHUNK_WORDS);
    if (!chunks.length && full.length > 30) {
        const fallback = full.substring(0, 8000);
        if (wordCountKb(fallback) >= 4) chunks = [fallback];
    }
    if (!chunks.length) {
        return { ok: false, chunks: 0, error: 'no_indexable_chunks' };
    }
    const baseSrc = kbEntryDocumentSourceUrl(id);
    const chunkTitles = chunks.map((_, i) =>
        chunks.length > 1 ? `${title} (part ${i + 1}/${chunks.length})` : title
    );
    const embedInputs = chunkTitles.map((t, i) => t + '\n\n' + chunks[i]);
    const embeddings = await generateEmbeddings(embedInputs);
    for (let i = 0; i < chunks.length; i++) {
        const embeddingStr = '[' + embeddings[i].join(',') + ']';
        const meta = { manual: true, kb_synced: true, kb_entry_id: String(id) };
        await db.query(
            `INSERT INTO documents (source_url, title, content, chunk_index, embedding, category, metadata)
             VALUES ($1, $2, $3, $4, $5::vector, $6, $7::jsonb)
             ON CONFLICT (source_url, chunk_index) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
               embedding = EXCLUDED.embedding, category = EXCLUDED.category, metadata = EXCLUDED.metadata, indexed_at = NOW()`,
            [baseSrc, chunkTitles[i], chunks[i], i, embeddingStr, category, JSON.stringify(meta)]
        );
    }
    return { ok: true, chunks: chunks.length, mode: 'indexed' };
}

async function extractTextFromPdfBuffer(buffer) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
        const textResult = await parser.getText();
        const infoResult = await parser.getInfo();
        const text = (textResult.text || '').replace(/\s+/g, ' ').trim();
        const dict = infoResult.info || {};
        const docTitle = dict.Title || dict.title || null;
        return { text, docTitle };
    } finally {
        await parser.destroy();
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
        cb(null, ok);
    }
});

const uploadKbPdf = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const name = (file.originalname || '').toLowerCase();
        const ok = file.mimetype === 'application/pdf' || name.endsWith('.pdf');
        cb(null, ok);
    }
});

router.use(requireAuth, requireAdmin, adminLimiter);

router.get('/stats', async (req, res, next) => {
    try {
        const today = await db.query(`SELECT COUNT(*)::int AS c FROM chats WHERE created_at::date = CURRENT_DATE`);
        const week = await db.query(`SELECT COUNT(*)::int AS c FROM chats WHERE created_at >= NOW() - INTERVAL '7 days'`);
        const weekPrev = await db.query(
            `SELECT COUNT(*)::int AS c FROM chats WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'`
        );
        const month = await db.query(`SELECT COUNT(*)::int AS c FROM chats WHERE created_at >= NOW() - INTERVAL '30 days'`);
        const totalChats = await db.query(`SELECT COUNT(*)::int AS c FROM chats`);
        const activeUsers = await db.query(
            `SELECT COUNT(DISTINCT user_id)::int AS c FROM chats WHERE user_id IS NOT NULL AND updated_at >= NOW() - INTERVAL '7 days'`
        );
        const activeUsersPrev = await db.query(
            `SELECT COUNT(DISTINCT user_id)::int AS c FROM chats WHERE user_id IS NOT NULL AND updated_at >= NOW() - INTERVAL '14 days' AND updated_at < NOW() - INTERVAL '7 days'`
        );
        const guestWeek = await db.query(
            `SELECT COUNT(DISTINCT guest_token)::int AS c FROM chats WHERE guest_token IS NOT NULL AND created_at >= NOW() - INTERVAL '7 days'`
        );
        const pendingEsc = await db.query(`SELECT COUNT(*)::int AS c FROM escalations WHERE status IN ('pending','in_progress')`);
        const avgConf = await db.query(
            `SELECT AVG(confidence_score)::float AS a FROM messages WHERE role = 'assistant' AND created_at::date = CURRENT_DATE AND confidence_score IS NOT NULL`
        );
        const tokensMonth = await db.query(
            `SELECT COALESCE(SUM(tokens_used),0)::bigint AS s FROM messages WHERE role = 'assistant' AND created_at >= date_trunc('month', NOW())`
        );
        const docRows = await db.query(`SELECT COUNT(*)::int AS c FROM documents`);
        const docSources = await db.query(`SELECT COUNT(DISTINCT source_url)::int AS c FROM documents`);
        const docsIndexedWeek = await db.query(
            `SELECT COUNT(*)::int AS c FROM documents WHERE indexed_at >= NOW() - INTERVAL '7 days'`
        );
        const docsIndexedPrev = await db.query(
            `SELECT COUNT(*)::int AS c FROM documents WHERE indexed_at >= NOW() - INTERVAL '14 days' AND indexed_at < NOW() - INTERVAL '7 days'`
        );
        const feedbackRoll = await db.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                )::int AS recent_n,
                COUNT(*) FILTER (
                    WHERE rating IS TRUE AND created_at >= NOW() - INTERVAL '7 days'
                )::int AS recent_pos,
                COUNT(*) FILTER (
                    WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'
                )::int AS prev_n,
                COUNT(*) FILTER (
                    WHERE rating IS TRUE AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'
                )::int AS prev_pos,
                COUNT(*)::int AS feedback_total
            FROM feedback
        `);
        const inputCost = 0.0000025;
        const outputCost = 0.00001;
        const estCost = (parseInt(tokensMonth.rows[0].s, 10) || 0) * ((inputCost + outputCost) / 2);

        const fr = feedbackRoll.rows[0] || {};
        const recentN = fr.recent_n || 0;
        const prevN = fr.prev_n || 0;
        const satRecent = recentN > 0 ? fr.recent_pos / recentN : null;
        const satPrev = prevN > 0 ? fr.prev_pos / prevN : null;
        let satisfaction_pct = null;
        let satisfaction_pts_delta = null;
        if ((fr.feedback_total || 0) > 0) {
            const allPos = await db.query(`SELECT COUNT(*) FILTER (WHERE rating IS TRUE)::int AS p, COUNT(*)::int AS n FROM feedback`);
            const n = allPos.rows[0].n || 0;
            if (n > 0) satisfaction_pct = Math.round((allPos.rows[0].p / n) * 1000) / 10;
        }
        if (satRecent != null && satPrev != null) {
            satisfaction_pts_delta = Math.round((satRecent - satPrev) * 1000) / 10;
        }

        const cw = week.rows[0].c || 0;
        const cp = weekPrev.rows[0].c || 0;
        const au = activeUsers.rows[0].c || 0;
        const ap = activeUsersPrev.rows[0].c || 0;
        const diw = docsIndexedWeek.rows[0].c || 0;
        const dip = docsIndexedPrev.rows[0].c || 0;

        const pctDelta = (cur, prev) => {
            if (prev > 0) return Math.round(((cur - prev) / prev) * 1000) / 10;
            if (cur > 0) return null;
            return 0;
        };

        res.json({
            conversations_today: today.rows[0].c,
            conversations_week: cw,
            conversations_month: month.rows[0].c,
            conversations_total: totalChats.rows[0].c,
            active_users_7d: au,
            guest_sessions_week: guestWeek.rows[0].c,
            pending_escalations: pendingEsc.rows[0].c,
            avg_confidence_today: avgConf.rows[0].a,
            estimated_api_cost_month_usd: Math.round(estCost * 10000) / 10000,
            tokens_this_month: parseInt(tokensMonth.rows[0].s, 10) || 0,
            documents_chunks: docRows.rows[0].c,
            documents_sources: docSources.rows[0].c,
            satisfaction_pct,
            trends: {
                conversations_week_pct: pctDelta(cw, cp),
                active_users_7d_pct: pctDelta(au, ap),
                documents_indexed_week_pct: pctDelta(diw, dip),
                satisfaction_pts_delta
            }
        });
    } catch (err) {
        next(err);
    }
});

router.get('/stats/timeseries', async (req, res, next) => {
    try {
        const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
        const result = await db.query(
            `SELECT (created_at AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS c
             FROM chats WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
             GROUP BY 1 ORDER BY 1`,
            [days]
        );
        res.json({ points: result.rows });
    } catch (err) {
        next(err);
    }
});

router.get('/stats/categories', async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT COALESCE(category,'general') AS category, COUNT(*)::int AS count
             FROM documents GROUP BY 1 ORDER BY count DESC`
        );
        res.json({ categories: result.rows });
    } catch (err) {
        next(err);
    }
});

/** Topic mix from user message text (keyword buckets; last N days). */
router.get('/stats/topics', async (req, res, next) => {
    try {
        const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
        const result = await db.query(
            `WITH user_msgs AS (
                SELECT lower(content) AS c
                FROM messages
                WHERE role = 'user'
                  AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
                  AND length(trim(content)) > 0
            ),
            tagged AS (
                SELECT CASE
                    WHEN c ~ 'admission|applicant|apply|intake|entry requirement|enroll' THEN 'Admissions'
                    WHEN c ~ 'fee|tuition|payment|pay fees|billing|invoice|bursar' THEN 'Fees & payments'
                    WHEN c ~ 'exam|test|assessment|quiz|result|grade|mark|gpa' THEN 'Exams & grades'
                    WHEN c ~ 'graduat|degree|certificate|diploma|convocation' THEN 'Graduation'
                    WHEN c ~ 'hostel|accommodation|housing|hall|dorm|residence' THEN 'Accommodation'
                    WHEN c ~ 'library|borrow|book' THEN 'Library'
                    WHEN c ~ 'register|registration|course|module|timetable|curriculum' THEN 'Courses & registration'
                    WHEN c ~ 'scholarship|bursary|financial aid|sponsor' THEN 'Scholarships'
                    WHEN c ~ 'deadline|due date|extension' THEN 'Deadlines'
                    WHEN c ~ 'transcript|portal|student record' THEN 'Records & portal'
                    ELSE 'Other topics'
                END AS topic
                FROM user_msgs
            )
            SELECT topic, COUNT(*)::int AS count
            FROM tagged
            GROUP BY topic
            ORDER BY count DESC`,
            [days]
        );
        const rows = result.rows.filter(r => r.count > 0);
        const maxSlices = 6;
        let segments = [];
        if (rows.length === 0) {
            segments = [];
        } else if (rows.length <= maxSlices) {
            segments = rows.map(r => ({ label: r.topic, value: r.count }));
        } else {
            segments = rows.slice(0, maxSlices - 1).map(r => ({ label: r.topic, value: r.count }));
            const rest = rows.slice(maxSlices - 1).reduce((s, r) => s + r.count, 0);
            if (rest > 0) {
                const other = segments.find(x => x.label === 'Other topics');
                if (other) other.value += rest;
                else segments.push({ label: 'Other topics', value: rest });
            }
        }
        res.json({ segments, days });
    } catch (err) {
        next(err);
    }
});

/** Operational mix for admin dashboard donut (weekly chat/message volume, not KB categories). */
router.get('/stats/performance-overview', async (req, res, next) => {
    try {
        const chatMix = await db.query(
            `SELECT
                 COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int AS reg_chats,
                 COUNT(*) FILTER (WHERE user_id IS NULL)::int AS guest_chats
             FROM chats
             WHERE created_at >= NOW() - INTERVAL '7 days'`
        );
        const msgMix = await db.query(
            `SELECT
                 COUNT(*) FILTER (WHERE role = 'user')::int AS user_msgs,
                 COUNT(*) FILTER (WHERE role = 'assistant')::int AS asst_msgs
             FROM messages
             WHERE created_at >= NOW() - INTERVAL '7 days'
               AND role IN ('user', 'assistant')`
        );

        const r = chatMix.rows[0] || {};
        const m = msgMix.rows[0] || {};

        const segments = [
            { label: 'Signed-in chats', value: r.reg_chats || 0 },
            { label: 'Guest chats', value: r.guest_chats || 0 },
            { label: 'User messages', value: m.user_msgs || 0 },
            { label: 'Assistant replies', value: m.asst_msgs || 0 }
        ];

        res.json({ segments });
    } catch (err) {
        next(err);
    }
});

router.get('/stats/tools', async (req, res, next) => {
    try {
        const tools = getToolSchemas().map(t => ({
            name: t.function.name,
            calls_week: 0,
            calls_month: 0,
            avg_ms: null,
            error_rate: 0
        }));
        res.json({ tools });
    } catch (err) {
        next(err);
    }
});

router.get('/stats/storage', async (req, res, next) => {
    try {
        const buckets = [
            process.env.MINIO_BUCKET_DOCUMENTS || 'documents',
            process.env.MINIO_BUCKET_UPLOADS || 'uploads',
            process.env.MINIO_BUCKET_EXPORTS || 'exports',
            process.env.MINIO_BUCKET_REFERENCE || 'reference'
        ];
        const out = [];
        for (const b of buckets) {
            try {
                const files = await storage.listFiles(b, '');
                const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
                out.push({ bucket: b, files: files.length, bytes });
            } catch {
                out.push({ bucket: b, files: 0, bytes: 0, error: 'unavailable' });
            }
        }
        res.json({ buckets: out, minio_console: process.env.MINIO_CONSOLE_URL || 'http://127.0.0.1:9001' });
    } catch (err) {
        next(err);
    }
});

router.get('/stats/messages-by-hour', async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS h, COUNT(*)::int AS c
             FROM messages WHERE created_at >= NOW() - INTERVAL '30 days'
             GROUP BY 1 ORDER BY 1`
        );
        res.json({ hours: result.rows });
    } catch (err) {
        next(err);
    }
});

router.get('/activity/recent', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const result = await db.query(
            `SELECT c.id, c.title, c.created_at, c.updated_at, c.user_id, c.guest_token,
                    u.full_name, u.email,
                    (SELECT content FROM messages m WHERE m.chat_id = c.id AND m.role = 'user' ORDER BY m.created_at ASC LIMIT 1) AS first_message,
                    EXISTS (SELECT 1 FROM escalations e WHERE e.chat_id = c.id AND e.status IN ('pending','in_progress')) AS escalated
             FROM chats c
             LEFT JOIN users u ON u.id = c.user_id
             ORDER BY c.updated_at DESC
             LIMIT $1`,
            [limit]
        );
        res.json({ chats: result.rows });
    } catch (err) {
        next(err);
    }
});

router.get('/escalations', async (req, res, next) => {
    try {
        const { status, page = 1, limit = 20, from, to } = req.query;
        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const params = [];
        let where = [];
        let i = 1;
        if (status) {
            where.push(`e.status = $${i++}`);
            params.push(status);
        }
        if (from) {
            where.push(`e.created_at >= $${i++}`);
            params.push(from);
        }
        if (to) {
            where.push(`e.created_at <= $${i++}`);
            params.push(to);
        }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        params.push(parseInt(limit, 10), offset);
        const sql = `
            SELECT e.*, c.title AS chat_title, m.content AS message_content,
                   u.full_name AS user_name, u.email AS user_email
            FROM escalations e
            JOIN chats c ON c.id = e.chat_id
            JOIN messages m ON m.id = e.message_id
            LEFT JOIN users u ON u.id = c.user_id
            ${w}
            ORDER BY e.created_at DESC
            LIMIT $${i} OFFSET $${i + 1}`;
        const result = await db.query(sql, params);
        const countSql = `SELECT COUNT(*)::int AS c FROM escalations e ${w}`;
        const countResult = await db.query(countSql, params.slice(0, params.length - 2));
        res.json({
            escalations: result.rows,
            total: countResult.rows[0].c,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10)
        });
    } catch (err) {
        next(err);
    }
});

router.get('/escalations/:id', async (req, res, next) => {
    try {
        const esc = await db.query(
            `SELECT e.*, c.title AS chat_title, c.user_id, c.guest_token, u.full_name, u.email
             FROM escalations e
             JOIN chats c ON c.id = e.chat_id
             LEFT JOIN users u ON u.id = c.user_id
             WHERE e.id = $1`,
            [req.params.id]
        );
        if (!esc.rows.length) return res.status(404).json({ error: 'Not found' });
        const msgs = await db.query(
            `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC`,
            [esc.rows[0].chat_id]
        );
        for (const m of msgs.rows) {
            if (m.image_key) {
                m.image_url = await storage.getPresignedUrl(UP_BUCKET, m.image_key).catch(() => null);
            }
        }
        res.json({ escalation: esc.rows[0], messages: msgs.rows });
    } catch (err) {
        next(err);
    }
});

router.patch('/escalations/:id', async (req, res, next) => {
    try {
        const { status, admin_response } = req.body;
        if (!status) return res.status(400).json({ error: 'Status required' });

        const updates = ['status = $1', `resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END`];
        const params = [status];
        let idx = 2;
        if (admin_response) {
            updates.push(`admin_response = $${idx++}`);
            params.push(admin_response);
        }
        params.push(req.params.id);

        const result = await db.query(
            `UPDATE escalations SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            params
        );

        if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

        const esc = result.rows[0];

        // If resolved and has an admin response, publish to KB and send email
        if (status === 'resolved' && admin_response) {
            // 1. Send feedback email
            let targetEmail = esc.user_email;
            if (!targetEmail && esc.chat_id) {
                const u = await db.query(
                    `SELECT u.email FROM users u JOIN chats c ON c.user_id = u.id WHERE c.id = $1`,
                    [esc.chat_id]
                );
                if (u.rows.length) targetEmail = u.rows[0].email;
            }

            if (targetEmail) {
                const subject = `Update on your AskMak ticket: ${esc.title || 'Inquiry'}`;
                const html = `<p>Hello,</p><p>Your ticket has been resolved with the following response:</p><p><strong>${admin_response}</strong></p><p>Thank you for using AskMak.</p>`;
                await emailService.sendMail(targetEmail, subject, html);
            }

            // 2. Publish to Knowledge Base
            const kbTitle = esc.title || 'Resolved Inquiry';
            const kbCategory = esc.category || 'general';
            const emb = await generateEmbedding(kbTitle + '\n\n' + admin_response);
            const embStr = '[' + emb.join(',') + ']';
            const src = 'escalation://' + esc.id;

            await db.query(
                `INSERT INTO documents (source_url, title, content, chunk_index, embedding, category, metadata)
                 VALUES ($1, $2, $3, 0, $4::vector, $5, $6::jsonb)
                 ON CONFLICT (source_url, chunk_index) DO UPDATE SET 
                    title = EXCLUDED.title, 
                    content = EXCLUDED.content,
                    embedding = EXCLUDED.embedding, 
                    category = EXCLUDED.category, 
                    metadata = EXCLUDED.metadata, 
                    indexed_at = NOW()`,
                [src, kbTitle, admin_response, embStr, kbCategory, JSON.stringify({ escalation_id: esc.id })]
            );
        }

        if (admin_response && esc.chat_id) {
            await db.query(
                `INSERT INTO messages (chat_id, role, content) VALUES ($1, 'system', $2)`,
                [esc.chat_id, 'Staff response: ' + admin_response]
            );
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.get('/unresolved', async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const base = `SELECT m.id, m.chat_id, m.content, m.confidence_score, m.created_at,
                    c.user_id, c.guest_token, u.full_name, u.email
             FROM messages m
             JOIN chats c ON c.id = m.chat_id
             LEFT JOIN users u ON u.id = c.user_id
             WHERE m.role = 'assistant'
             AND (
               (m.confidence_score IS NOT NULL AND m.confidence_score < 0.65)
               OR m.content ILIKE '%not sure%'
               OR m.content ILIKE '%don''t have%'
               OR m.content ILIKE '%couldn''t find%'
               OR m.content ILIKE '%no information%'
             )`;
        const withDismiss = `${base}
             AND NOT EXISTS (SELECT 1 FROM admin_unresolved_dismissals d WHERE d.message_id = m.id)
             ORDER BY m.created_at DESC
             LIMIT $1`;
        let result;
        try {
            result = await db.query(withDismiss, [limit]);
        } catch (err) {
            if (err.code !== '42P01') throw err;
            result = await db.query(`${base} ORDER BY m.created_at DESC LIMIT $1`, [limit]);
        }
        res.json({ items: result.rows });
    } catch (err) {
        next(err);
    }
});

router.patch('/unresolved/:id', async (req, res, next) => {
    try {
        const messageId = req.params.id;
        const action = req.body.action;
        if (action === 'dismiss') {
            try {
                await db.query(
                    `INSERT INTO admin_unresolved_dismissals (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING`,
                    [messageId]
                );
            } catch (e) {
                if (e.code === '42P01') {
                    return res.status(503).json({ error: 'Run db/admin_schema.sql (admin_unresolved_dismissals missing)' });
                }
                throw e;
            }
            return res.json({ ok: true });
        }
        if (action === 'escalate') {
            const m = await db.query(
                `SELECT m.id, m.chat_id FROM messages m WHERE m.id = $1 AND m.role = 'assistant'`,
                [messageId]
            );
            if (!m.rows.length) return res.status(404).json({ error: 'Assistant message not found' });
            const existing = await db.query('SELECT id FROM escalations WHERE message_id = $1', [messageId]);
            if (existing.rows.length) return res.json({ ok: true, escalation_id: existing.rows[0].id });
            const ins = await db.query(
                `INSERT INTO escalations (chat_id, message_id, reason, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
                [m.rows[0].chat_id, messageId, 'Flagged from unresolved review queue']
            );
            return res.json({ ok: true, escalation_id: ins.rows[0].id });
        }
        return res.status(400).json({ error: 'action must be dismiss or escalate' });
    } catch (err) {
        next(err);
    }
});

router.get('/users', async (req, res, next) => {
    try {
        const q = req.query.q || '';
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
        const offset = (page - 1) * limit;
        const params = [];
        let whereClause = '';
        if (q) {
            whereClause = 'WHERE (u.full_name ILIKE $1 OR u.email ILIKE $1)';
            params.push('%' + q + '%');
        }
        params.push(limit, offset);
        const lim = params.length - 1;
        const off = params.length;
        const sql = `
            SELECT u.id, u.full_name, u.email, u.role, u.email_verified, u.created_at,
                   (SELECT MAX(c.updated_at) FROM chats c WHERE c.user_id = u.id) AS last_active,
                   (SELECT COUNT(*)::int FROM chats c WHERE c.user_id = u.id) AS chat_count
            FROM users u
            ${whereClause}
            ORDER BY u.created_at DESC
            LIMIT $${lim} OFFSET $${off}`;
        const [list, count, summaryResult] = await Promise.all([
            db.query(sql, params),
            db.query(`SELECT COUNT(*)::int AS c FROM users u ${whereClause}`, q ? [params[0]] : []),
            db.query(
                `SELECT COUNT(*)::int AS total_registered,
                        COUNT(*) FILTER (WHERE email_verified = TRUE)::int AS verified,
                        COUNT(*) FILTER (WHERE email_verified = FALSE)::int AS pending_verification,
                        COUNT(*) FILTER (WHERE role = 'admin')::int AS admins
                 FROM users`
            )
        ]);
        res.json({
            users: list.rows,
            total: count.rows[0].c,
            page,
            limit,
            summary: summaryResult.rows[0]
        });
    } catch (err) {
        next(err);
    }
});

router.get('/users/:id', async (req, res, next) => {
    try {
        const user = await db.query('SELECT id, full_name, email, role, email_verified, created_at FROM users WHERE id = $1', [req.params.id]);
        if (!user.rows.length) return res.status(404).json({ error: 'Not found' });
        const memories = await db.query('SELECT * FROM user_memories WHERE user_id = $1 ORDER BY updated_at DESC', [req.params.id]);
        const chats = await db.query(
            `SELECT id, title, created_at, updated_at FROM chats WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
            [req.params.id]
        );
        const fb = await db.query(
            `SELECT COUNT(*) FILTER (WHERE rating = true)::int AS up,
                    COUNT(*) FILTER (WHERE rating = false)::int AS down
             FROM feedback WHERE user_id = $1`
        );
        res.json({ user: user.rows[0], memories: memories.rows, chats: chats.rows, feedback: fb.rows[0] });
    } catch (err) {
        next(err);
    }
});

router.delete('/users/:id', async (req, res, next) => {
    try {
        if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete self' });
        const u = await db.query('SELECT role FROM users WHERE id = $1', [req.params.id]);
        if (!u.rows.length) return res.status(404).json({ error: 'Not found' });
        if (u.rows[0].role === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
        await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.get('/conversations', async (req, res, next) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const offset = (page - 1) * limit;
        const q = req.query.q || '';
        const guest = req.query.guest;
        const params = [];
        let where = [];
        let i = 1;
        if (q) {
            where.push(`(c.title ILIKE $${i} OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.content ILIKE $${i}))`);
            params.push('%' + q + '%');
            i++;
        }
        if (guest === '1') {
            where.push('c.user_id IS NULL AND c.guest_token IS NOT NULL');
        } else if (guest === '0') {
            where.push('c.user_id IS NOT NULL');
        }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        params.push(limit, offset);
        const sql = `
            SELECT c.*, u.full_name, u.email,
                   (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS message_count,
                   (SELECT AVG(confidence_score) FROM messages m WHERE m.chat_id = c.id AND m.role = 'assistant') AS avg_confidence,
                   EXISTS (SELECT 1 FROM escalations e WHERE e.chat_id = c.id) AS has_escalation,
                   EXISTS (SELECT 1 FROM feedback f JOIN messages m ON m.id = f.message_id WHERE m.chat_id = c.id AND f.rating = false) AS has_negative_feedback,
                   EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.image_key IS NOT NULL) AS has_images
            FROM chats c
            LEFT JOIN users u ON u.id = c.user_id
            ${w}
            ORDER BY c.updated_at DESC
            LIMIT $${i} OFFSET $${i + 1}`;
        const result = await db.query(sql, params);
        const countSql = `SELECT COUNT(*)::int AS c FROM chats c ${w}`;
        const count = await db.query(countSql, params.slice(0, params.length - 2));
        res.json({ conversations: result.rows, total: count.rows[0].c, page, limit });
    } catch (err) {
        next(err);
    }
});

router.get('/conversations/:id', async (req, res, next) => {
    try {
        const chat = await db.query(
            `SELECT c.*, u.full_name, u.email FROM chats c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
            [req.params.id]
        );
        if (!chat.rows.length) return res.status(404).json({ error: 'Not found' });
        const msgs = await db.query(
            `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC`,
            [req.params.id]
        );
        for (const m of msgs.rows) {
            if (m.image_key) {
                m.image_url = await storage.getPresignedUrl(UP_BUCKET, m.image_key).catch(() => null);
            }
        }
        res.json({ chat: chat.rows[0], messages: msgs.rows });
    } catch (err) {
        next(err);
    }
});

router.get('/feedback', async (req, res, next) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
        const offset = (page - 1) * limit;
        const rating = req.query.rating;
        const params = [];
        let where = '';
        if (rating === 'up') {
            where = 'WHERE f.rating = true';
        } else if (rating === 'down') {
            where = 'WHERE f.rating = false';
        }
        params.push(limit, offset);
        const sql = `
            SELECT f.*, m.content AS message_preview, m.chat_id,
                   (SELECT content FROM messages m2 WHERE m2.chat_id = m.chat_id AND m2.role = 'assistant' AND m2.created_at < m.created_at ORDER BY m2.created_at DESC LIMIT 1) AS bot_preview,
                   u.full_name, u.email, c.guest_token
            FROM feedback f
            JOIN messages m ON m.id = f.message_id
            JOIN chats c ON c.id = m.chat_id
            LEFT JOIN users u ON u.id = f.user_id
            ${where}
            ORDER BY f.created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`;
        const result = await db.query(sql, params);
        const count = await db.query(`SELECT COUNT(*)::int AS c FROM feedback f ${where}`);
        res.json({ feedback: result.rows, total: count.rows[0].c, page, limit });
    } catch (err) {
        next(err);
    }
});

router.get('/feedback/export', async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT f.created_at, f.rating, f.comment, m.content AS message_content, c.id AS chat_id,
                    u.email, c.guest_token
             FROM feedback f
             JOIN messages m ON m.id = f.message_id
             JOIN chats c ON c.id = m.chat_id
             LEFT JOIN users u ON u.id = f.user_id
             ORDER BY f.created_at DESC
             LIMIT 5000`
        );
        const headers = ['created_at', 'rating', 'comment', 'message', 'chat_id', 'user_email', 'guest'];
        const lines = [headers.join(',')];
        for (const row of result.rows) {
            const cells = [
                row.created_at,
                row.rating,
                (row.comment || '').replace(/"/g, '""'),
                (row.message_content || '').replace(/"/g, '""').substring(0, 2000),
                row.chat_id,
                row.email || '',
                row.guest_token || ''
            ].map(v => `"${String(v).replace(/"/g, '""')}"`);
            lines.push(cells.join(','));
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="askmak-feedback.csv"');
        res.send(lines.join('\n'));
    } catch (err) {
        next(err);
    }
});

router.get('/documents', async (req, res, next) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
        const offset = (page - 1) * limit;
        const cat = req.query.category;
        const q = req.query.q || '';
        const params = [];
        let where = [];
        let i = 1;
        if (cat) {
            where.push(`category = $${i++}`);
            params.push(cat);
        }
        if (q) {
            where.push(`(title ILIKE $${i} OR content ILIKE $${i})`);
            params.push('%' + q + '%');
            i++;
        }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        params.push(limit, offset);
        const sql = `SELECT id, source_url, title, chunk_index, category, image_keys, indexed_at, metadata,
            LEFT(content, 200) AS content_preview
            FROM documents ${w} ORDER BY indexed_at DESC LIMIT $${i} OFFSET $${i + 1}`;
        const result = await db.query(sql, params);
        const count = await db.query(`SELECT COUNT(*)::int AS c FROM documents ${w}`, params.slice(0, params.length - 2));
        res.json({ documents: result.rows, total: count.rows[0].c, page, limit });
    } catch (err) {
        next(err);
    }
});

/** Must be registered before GET /documents/:id so "upload-pdf" is not parsed as an id. */
router.post('/documents/upload-pdf', (req, res, next) => {
    uploadKbPdf.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'PDF too large (max 25MB)' });
            }
            return next(err);
        }
        next();
    });
}, async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'PDF file required (field name: file)' });
        }
        const category = (req.body.category || 'faq').trim() || 'faq';
        let title = (req.body.title || '').trim();
        const buffer = req.file.buffer;

        let text;
        let docTitleFromPdf = null;
        try {
            const extracted = await extractTextFromPdfBuffer(buffer);
            text = extracted.text;
            docTitleFromPdf = extracted.docTitle;
        } catch (e) {
            return res.status(400).json({ error: 'Could not read PDF: ' + (e && e.message ? e.message : String(e)) });
        }

        if (!text || text.length < 20) {
            return res.status(400).json({ error: 'No extractable text in this PDF (scanned PDFs may need OCR).' });
        }

        if (!title) {
            title =
                (docTitleFromPdf && String(docTitleFromPdf).trim()) ||
                path.parse(req.file.originalname || 'upload').name ||
                'Uploaded PDF';
        }
        const maxTitle = 500;
        if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + '…';

        const rawChunks = chunkText(text);
        let chunks = rawChunks.filter((c) => wordCountKb(c) >= MIN_KB_CHUNK_WORDS);
        if (!chunks.length && text.length > 20) {
            const fallback = text.substring(0, 8000);
            if (wordCountKb(fallback) >= 4) chunks = [fallback];
        }
        if (!chunks.length) {
            return res.status(400).json({ error: 'Could not produce searchable segments from this PDF.' });
        }

        const baseSrc = 'manual-pdf://' + uuidv4();
        const chunkTitles = chunks.map((_, i) =>
            chunks.length > 1 ? `${title} (part ${i + 1}/${chunks.length})` : title
        );
        const embedInputs = chunkTitles.map((t, i) => t + '\n\n' + chunks[i]);
        const embeddings = await generateEmbeddings(embedInputs);

        const ids = [];
        for (let i = 0; i < chunks.length; i++) {
            const embeddingStr = '[' + embeddings[i].join(',') + ']';
            const meta = {
                manual: true,
                pdf_upload: true,
                original_filename: req.file.originalname || null,
                chunk_index_display: i,
                chunk_of: chunks.length
            };
            const result = await db.query(
                `INSERT INTO documents (source_url, title, content, chunk_index, embedding, category, metadata)
                 VALUES ($1, $2, $3, $4, $5::vector, $6, $7::jsonb)
                 ON CONFLICT (source_url, chunk_index) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
                   embedding = EXCLUDED.embedding, category = EXCLUDED.category, metadata = EXCLUDED.metadata, indexed_at = NOW()
                 RETURNING id`,
                [baseSrc, chunkTitles[i], chunks[i], i, embeddingStr, category, JSON.stringify(meta)]
            );
            ids.push(result.rows[0].id);
        }

        res.status(201).json({ inserted: ids.length, ids, title });
    } catch (err) {
        next(err);
    }
});

router.get('/documents/:id', async (req, res, next) => {
    try {
        const r = await db.query(
            `SELECT id, title, content, category, source_url, chunk_index, metadata, image_keys, indexed_at
             FROM documents WHERE id = $1`,
            [req.params.id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ document: r.rows[0] });
    } catch (err) {
        next(err);
    }
});

router.post('/documents', async (req, res, next) => {
    try {
        const { title, content, category, source_url } = req.body;
        if (!title || !content) return res.status(400).json({ error: 'title and content required' });
        const emb = await generateEmbedding(title + '\n\n' + content);
        const embStr = '[' + emb.join(',') + ']';
        const src = source_url || 'manual://' + uuidv4();
        const result = await db.query(
            `INSERT INTO documents (source_url, title, content, chunk_index, embedding, category, metadata)
             VALUES ($1, $2, $3, 0, $4::vector, $5, $6::jsonb)
             ON CONFLICT (source_url, chunk_index) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
               embedding = EXCLUDED.embedding, category = EXCLUDED.category, metadata = EXCLUDED.metadata, indexed_at = NOW()
             RETURNING id`,
            [src, title, content, embStr, category || 'faq', JSON.stringify({ manual: true })]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        next(err);
    }
});

router.put('/documents/:id', async (req, res, next) => {
    try {
        const { title, content, category, source_url } = req.body;
        const cur = await db.query(
            `SELECT id, title, content, category, source_url, metadata FROM documents WHERE id = $1`,
            [req.params.id]
        );
        if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
        const doc = cur.rows[0];
        let meta = doc.metadata;
        if (typeof meta === 'string') {
            try {
                meta = JSON.parse(meta);
            } catch {
                meta = {};
            }
        }
        const isKbEntrySync =
            doc.source_url && String(doc.source_url).startsWith('kb-entry://');
        if (isKbEntrySync) {
            return res.status(403).json({
                error:
                    'This chunk is synced from Knowledge Base — edit the FAQ entry there so the browse view and assistant index stay in sync.'
            });
        }
        const isManual =
            (meta && meta.manual === true) ||
            (doc.source_url &&
                (String(doc.source_url).startsWith('manual://') || String(doc.source_url).startsWith('manual-pdf://')));
        if (!isManual) return res.status(403).json({ error: 'Only manual knowledge entries can be edited here' });
        const newTitle = title != null ? title : doc.title;
        const newContent = content != null ? content : doc.content;
        const newCat = category != null ? category : doc.category;
        const newSrc = source_url != null ? source_url : doc.source_url;
        if (!newTitle || !newContent) return res.status(400).json({ error: 'title and content required' });
        const emb = await generateEmbedding(newTitle + '\n\n' + newContent);
        const embStr = '[' + emb.join(',') + ']';
        await db.query(
            `UPDATE documents SET title = $1, content = $2, category = $3, source_url = $4, embedding = $5::vector, indexed_at = NOW() WHERE id = $6`,
            [newTitle, newContent, newCat, newSrc, embStr, req.params.id]
        );
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.delete('/documents/:id', async (req, res, next) => {
    try {
        const sel = await db.query('SELECT id, source_url, image_keys FROM documents WHERE id = $1', [req.params.id]);
        if (!sel.rows.length) return res.status(404).json({ error: 'Not found' });
        const anchor = sel.rows[0];

        let toDelete = sel.rows;
        if (anchor.source_url && String(anchor.source_url).startsWith('kb-entry://')) {
            const siblings = await db.query(
                'SELECT id, image_keys FROM documents WHERE source_url = $1 ORDER BY chunk_index ASC',
                [anchor.source_url]
            );
            toDelete = siblings.rows;
        }

        for (const doc of toDelete) {
            let keys = doc.image_keys;
            if (typeof keys === 'string') {
                try {
                    keys = JSON.parse(keys);
                } catch {
                    keys = null;
                }
            }
            if (Array.isArray(keys)) {
                for (const k of keys) {
                    await storage.deleteFile(DOC_BUCKET, k).catch(() => {});
                }
            }
            await db.query('DELETE FROM documents WHERE id = $1', [doc.id]);
        }

        const removedKb = !!(anchor.source_url && String(anchor.source_url).startsWith('kb-entry://'));
        res.json({
            ok: true,
            deleted: toDelete.length,
            ...(removedKb
                ? {
                      warning:
                          'Removed assistant index chunks linked to a Knowledge Base entry; the curated FAQ row is unchanged.'
                  }
                : {})
        });
    } catch (err) {
        next(err);
    }
});

router.post('/ingest', async (req, res, next) => {
    try {
        const source = req.body.source || 'all';
        await db.query(
            `INSERT INTO ingestion_runs (source, status, stats) VALUES ($1, 'started', '{}')`,
            [source]
        );
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'ingest.js')], {
            cwd: path.join(__dirname, '..'),
            detached: true,
            stdio: 'ignore',
            env: { ...process.env }
        });
        child.unref();
        res.status(202).json({ message: 'Ingestion started in background', source });
    } catch (err) {
        next(err);
    }
});

router.get('/ingest/status', async (req, res, next) => {
    try {
        const result = await db.query(
            `SELECT id, source, status, stats, started_at, finished_at FROM ingestion_runs ORDER BY started_at DESC LIMIT 20`
        );
        const docCount = await db.query('SELECT COUNT(*)::int AS c FROM documents');
        res.json({ runs: result.rows, document_chunks: docCount.rows[0].c });
    } catch (err) {
        next(err);
    }
});

router.get('/reference-images', async (req, res, next) => {
    try {
        const files = await storage.listFiles(REF_BUCKET, '');
        const slice = files.slice(0, 500);
        const keys = slice.map(f => f.key);
        let metaByKey = {};
        if (keys.length) {
            try {
                const metaRows = await db.query(
                    'SELECT object_key, display_name, category, description, tags FROM admin_reference_image_meta WHERE object_key = ANY($1::text[])',
                    [keys]
                );
                metaByKey = Object.fromEntries(metaRows.rows.map(r => [r.object_key, r]));
            } catch (e) {
                if (e.code !== '42P01') throw e;
            }
        }
        const items = [];
        for (const f of slice) {
            const url = await storage.getPresignedUrl(REF_BUCKET, f.key).catch(() => null);
            const meta = metaByKey[f.key];
            items.push({
                key: f.key,
                size: f.size,
                url,
                display_name: meta ? meta.display_name : null,
                category: meta ? meta.category : null,
                description: meta ? meta.description : null,
                tags: meta ? meta.tags : null
            });
        }
        res.json({ images: items });
    } catch (err) {
        next(err);
    }
});

router.post('/reference-images', upload.single('image'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'image required' });
        const category = (req.body.category || 'maps').replace(/[^a-z0-9_-]/gi, '_');
        const name = (req.body.name || 'image').replace(/[^a-z0-9_-]/gi, '_');
        const ext = path.extname(req.file.originalname) || '.jpg';
        const key = `${category}/${name}_${uuidv4()}${ext}`;
        await storage.uploadFile(REF_BUCKET, key, req.file.buffer, req.file.mimetype);
        res.status(201).json({ key });
    } catch (err) {
        next(err);
    }
});

router.put('/reference-images/*key', async (req, res, next) => {
    try {
        const key = req.params.key;
        const { display_name, category, description, tags } = req.body;
        const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
        try {
            await db.query(
                `INSERT INTO admin_reference_image_meta (object_key, display_name, category, description, tags, updated_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                 ON CONFLICT (object_key) DO UPDATE SET
                   display_name = EXCLUDED.display_name,
                   category = EXCLUDED.category,
                   description = EXCLUDED.description,
                   tags = EXCLUDED.tags,
                   updated_at = NOW()`,
                [key, display_name ?? null, category ?? null, description ?? null, tagsJson]
            );
        } catch (e) {
            if (e.code === '42P01') {
                return res.status(503).json({ error: 'Run db/admin_schema.sql (admin_reference_image_meta missing)' });
            }
            throw e;
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.delete('/reference-images/*key', async (req, res, next) => {
    try {
        const key = req.params.key;
        await storage.deleteFile(REF_BUCKET, key);
        await db.query('DELETE FROM admin_reference_image_meta WHERE object_key = $1', [key]).catch(() => {});
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.get('/tools', async (req, res, next) => {
    try {
        const schemas = getToolSchemas();
        res.json({ tools: schemas.map(s => ({ name: s.function.name, description: s.function.description })) });
    } catch (err) {
        next(err);
    }
});

router.get('/tools/log', async (req, res, next) => {
    try {
        res.json({ calls: [] });
    } catch (err) {
        next(err);
    }
});

router.get('/storage/uploads', async (req, res, next) => {
    try {
        const files = await storage.listFiles(UP_BUCKET, '');
        const items = [];
        for (const f of files.slice(0, 500)) {
            const url = await storage.getPresignedUrl(UP_BUCKET, f.key, 600).catch(() => null);
            items.push({ key: f.key, size: f.size, url });
        }
        res.json({ files: items });
    } catch (err) {
        next(err);
    }
});

router.delete('/storage/uploads/*key', async (req, res, next) => {
    try {
        await storage.deleteFile(UP_BUCKET, req.params.key);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.get('/settings', async (req, res, next) => {
    try {
        const rows = await db.query('SELECT key, value FROM admin_settings');
        const settings = {};
        rows.rows.forEach(r => { settings[r.key] = r.value; });
        res.json({
            settings,
            openai_model: process.env.OPENAI_MODEL,
            embedding_model: process.env.EMBEDDING_MODEL
        });
    } catch (err) {
        if (err.code === '42P01') {
            return res.json({
                settings: {},
                openai_model: process.env.OPENAI_MODEL,
                embedding_model: process.env.EMBEDDING_MODEL,
                note: 'Run db/admin_schema.sql against your database'
            });
        }
        next(err);
    }
});

router.put('/settings', async (req, res, next) => {
    try {
        const body = req.body.settings || req.body;
        if (typeof body !== 'object' || body === null) return res.status(400).json({ error: 'Invalid body' });
        for (const key of Object.keys(body)) {
            if (key === 'openai_model' || key === 'embedding_model') continue;
            const val = body[key];
            await db.query(
                `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, JSON.stringify(val)]
            );
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ─── Admin: Rule-based Knowledge Base Entries ────────────────────────────────

const nodemailer = require('nodemailer');

function getKbMailTransport() {
    if (!process.env.SMTP_HOST) return null;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true';
    const opts = { host: process.env.SMTP_HOST, port, secure };
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        opts.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
    }
    if (port === 587 && !secure) opts.requireTLS = true;
    return nodemailer.createTransport(opts);
}

async function sendTicketResolutionMail(to, studentName, ticketTitle, adminResponse) {
    const transport = getKbMailTransport();
    if (!transport) {
        console.warn(`[AskMak] SMTP not configured — skipping ticket resolution email to ${to}`);
        return false;
    }
    const name = studentName || 'Student';
    const html = `
        <p>Dear ${name},</p>
        <p>Your support ticket <strong>"${ticketTitle}"</strong> has been resolved.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        <p><strong>Answer from the AskMak team:</strong></p>
        <p style="background:#f9fafb;border-left:4px solid #00a651;padding:12px 16px;border-radius:4px">${adminResponse.replace(/\n/g, '<br>')}</p>
        <p style="color:#6b7280;font-size:13px;margin-top:24px">
            This answer has been added to the AskMak knowledge base so other students can benefit from it.<br>
            Visit <a href="${process.env.CORS_ORIGIN || 'https://askmak.mak.ac.ug'}">AskMak</a> anytime for more help.
        </p>
        <p style="color:#6b7280;font-size:12px">— The Makerere University AskMak Team</p>`;
    try {
        await transport.sendMail({
            from: process.env.SMTP_FROM || '"AskMak" <noreply@mak.ac.ug>',
            to,
            subject: `[AskMak] Your ticket has been resolved: "${ticketTitle}"`,
            html
        });
        return true;
    } catch (err) {
        console.warn('[AskMak] Ticket resolution email failed:', err.message);
        return false;
    }
}

/** GET /api/admin/kb — list all KB entries */
router.get('/kb', async (req, res, next) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = (page - 1) * limit;
        const cat = req.query.category || '';
        const q = req.query.q || '';
        const params = [];
        const where = [];
        let i = 1;
        if (cat) { where.push(`category = $${i++}`); params.push(cat); }
        if (q)   { where.push(`(title ILIKE $${i} OR content ILIKE $${i})`); params.push('%' + q + '%'); i++; }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        params.push(limit, offset);
        const rows = await db.query(
            `SELECT id, category, title, LEFT(content,200) AS content_preview, is_published, created_at, updated_at
             FROM kb_entries ${w} ORDER BY category, title LIMIT $${i} OFFSET $${i + 1}`,
            params
        );
        const count = await db.query(`SELECT COUNT(*)::int AS c FROM kb_entries ${w}`, params.slice(0, -2));
        res.json({ entries: rows.rows, total: count.rows[0].c, page, limit });
    } catch (err) { next(err); }
});

/** GET /api/admin/kb/categories — distinct categories */
router.get('/kb/categories', async (req, res, next) => {
    try {
        const r = await db.query(`SELECT DISTINCT category FROM kb_entries ORDER BY category`);
        res.json({ categories: r.rows.map(row => row.category) });
    } catch (err) { next(err); }
});

/** GET /api/admin/kb/:id — single KB entry (full content).
 *  Keep /kb/categories registered above this route so "categories" is not parsed as :id. */
router.get('/kb/:id', async (req, res, next) => {
    try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const r = await db.query(`SELECT * FROM kb_entries WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ entry: r.rows[0] });
    } catch (err) { next(err); }
});

/** POST /api/admin/kb — create a KB entry */
router.post('/kb', async (req, res, next) => {
    try {
        const { category, title, content, is_published } = req.body;
        if (!category || !title || !content) {
            return res.status(400).json({ error: 'category, title, and content are required' });
        }
        const r = await db.query(
            `INSERT INTO kb_entries (category, title, content, is_published)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [category.trim(), title.trim(), content.trim(), is_published !== false]
        );
        const row = r.rows[0];
        let index_sync = null;
        try {
            index_sync = await syncKbEntryDocuments(row);
        } catch (syncErr) {
            index_sync = { ok: false, error: syncErr.message || String(syncErr) };
            console.warn('[AskMak] KB create→index sync failed:', syncErr.message);
        }
        res.status(201).json({ id: row.id, index_sync });
    } catch (err) { next(err); }
});

/** PUT /api/admin/kb/:id — update a KB entry */
router.put('/kb/:id', async (req, res, next) => {
    try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const { category, title, content, is_published } = req.body;
        const cur = await db.query(`SELECT id FROM kb_entries WHERE id = $1`, [req.params.id]);
        if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
        await db.query(
            `UPDATE kb_entries SET category=$1, title=$2, content=$3, is_published=$4, updated_at=NOW() WHERE id=$5`,
            [
                (category || '').trim(),
                (title || '').trim(),
                (content || '').trim(),
                is_published !== false,
                req.params.id
            ]
        );
        const full = await db.query(`SELECT * FROM kb_entries WHERE id = $1`, [req.params.id]);
        const row = full.rows[0];
        let index_sync = null;
        try {
            index_sync = await syncKbEntryDocuments(row);
        } catch (syncErr) {
            index_sync = { ok: false, error: syncErr.message || String(syncErr) };
            console.warn('[AskMak] KB update→index sync failed:', syncErr.message);
        }
        res.json({ ok: true, index_sync });
    } catch (err) { next(err); }
});

/** DELETE /api/admin/kb/:id */
router.delete('/kb/:id', async (req, res, next) => {
    try {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
            return res.status(404).json({ error: 'Not found' });
        }
        await removeKbSyncedDocuments(req.params.id);
        const r = await db.query(`DELETE FROM kb_entries WHERE id = $1 RETURNING id`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// ─── Admin: Support Tickets ───────────────────────────────────────────────────

/** GET /api/admin/kb/tickets — list tickets */
router.get('/kb-tickets', async (req, res, next) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = (page - 1) * limit;
        const status = req.query.status || '';
        const params = [];
        const where = [];
        let i = 1;
        if (status) { where.push(`status = $${i++}`); params.push(status); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        params.push(limit, offset);
        const rows = await db.query(
            `SELECT id, category, title, student_email, student_name, status, created_at, resolved_at
             FROM kb_tickets ${w} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
            params
        );
        const count = await db.query(`SELECT COUNT(*)::int AS c FROM kb_tickets ${w}`, params.slice(0, -2));
        const pending = await db.query(`SELECT COUNT(*)::int AS c FROM kb_tickets WHERE status = 'pending'`);
        res.json({ tickets: rows.rows, total: count.rows[0].c, pending_count: pending.rows[0].c, page, limit });
    } catch (err) { next(err); }
});

/** GET /api/admin/kb-tickets/:id — single ticket detail */
router.get('/kb-tickets/:id', async (req, res, next) => {
    try {
        const r = await db.query(`SELECT * FROM kb_tickets WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ ticket: r.rows[0] });
    } catch (err) { next(err); }
});

/** PATCH /api/admin/kb-tickets/:id — resolve ticket, notify student, optionally save KB entry */
router.patch('/kb-tickets/:id', async (req, res, next) => {
    try {
        const { admin_response, save_as_kb_entry } = req.body;
        if (!admin_response || !admin_response.trim()) {
            return res.status(400).json({ error: 'admin_response is required to resolve a ticket' });
        }
        const cur = await db.query(`SELECT * FROM kb_tickets WHERE id = $1`, [req.params.id]);
        if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
        const ticket = cur.rows[0];

        // Resolve ticket
        await db.query(
            `UPDATE kb_tickets
             SET status='resolved', admin_response=$1, content=$1, resolved_at=NOW()
             WHERE id=$2`,
            [admin_response.trim(), req.params.id]
        );

        // Send notification email
        let emailSent = false;
        try {
            emailSent = await sendTicketResolutionMail(
                ticket.student_email,
                ticket.student_name,
                ticket.title,
                admin_response.trim()
            );
            if (emailSent) {
                await db.query(`UPDATE kb_tickets SET notified_at=NOW() WHERE id=$1`, [req.params.id]);
            }
        } catch (mailErr) {
            console.warn('[AskMak] Email notification error:', mailErr.message);
        }

        // Optionally create a KB entry from the resolved ticket
        let kbEntryId = null;
        let entryIndexSync = null;
        if (save_as_kb_entry) {
            const kbInsert = await db.query(
                `INSERT INTO kb_entries (category, title, content)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [ticket.category, ticket.title, admin_response.trim()]
            );
            const kbRow = kbInsert.rows[0];
            kbEntryId = kbRow.id;
            try {
                entryIndexSync = await syncKbEntryDocuments(kbRow);
            } catch (syncErr) {
                entryIndexSync = { ok: false, error: syncErr.message || String(syncErr) };
                console.warn('[AskMak] KB ticket→index sync failed:', syncErr.message);
            }
        }

        res.json({ ok: true, email_sent: emailSent, kb_entry_id: kbEntryId, index_sync: entryIndexSync });
    } catch (err) { next(err); }
});

module.exports = router;

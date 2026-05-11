const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const db = require('./config/db');
const errorHandler = require('./middleware/error');
const { guestMiddleware } = require('./middleware/guest');
const { requireAdminPage } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const uploadRoutes = require('./routes/upload');
const escalationRoutes = require('./routes/escalation');
const feedbackRoutes = require('./routes/feedback');
const memoriesRoutes = require('./routes/memories');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');
const kbRoutes = require('./routes/kb');

const cron = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

function corsOriginSetting() {
    if (process.env.NODE_ENV !== 'production') {
        return [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    }
    const raw = process.env.CORS_ORIGIN || 'https://askmak.mak.ac.ug';
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length <= 1 ? (list[0] || raw) : list;
}

async function waitForDatabase() {
    if (process.env.SKIP_DB_WAIT === '1' || process.env.SKIP_DB_WAIT === 'true') {
        console.warn('SKIP_DB_WAIT set — skipping database check');
        return;
    }
    const isProd = process.env.NODE_ENV === 'production';
    const maxAttempts = parseInt(process.env.DB_CONNECT_MAX_ATTEMPTS || (isProd ? '60' : '15'), 10);
    const intervalMs = parseInt(process.env.DB_CONNECT_INTERVAL_MS || '1000', 10);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await db.query('SELECT 1');
            console.log('Database connected');
            return;
        } catch (err) {
            if (attempt === 1) console.warn('Database not ready:', err.message);
            else if (attempt % 10 === 0 || attempt === maxAttempts) {
                console.warn(`Still waiting for database (${attempt}/${maxAttempts})...`);
            }
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, intervalMs));
            }
        }
    }

    const hint =
        'Check DATABASE_URL and that Postgres is running (e.g. bash scripts/vps-bootstrap.sh or docker compose -f docker-compose.dockeruser.yml ps).';
    const msg = `Could not connect to the database after ${maxAttempts} attempts (~${Math.round((maxAttempts * intervalMs) / 1000)}s). ${hint}`;
    if (isProd) {
        console.error(msg);
        process.exit(1);
    }
    console.warn(msg);
    console.warn('Continuing without database (non-production).');
}

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

app.use(cors({
    origin: corsOriginSetting(),
    credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET));

const publicDir = path.join(__dirname, '..', 'frontend', 'public');
console.log('Serving static files from:', publicDir);

app.get('/admin.html', requireAdminPage, (req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use(express.static(publicDir));

app.use(guestMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/escalations', escalationRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/memories', memoriesRoutes);
app.use('/api', healthRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/kb', kbRoutes);

app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(errorHandler);

async function start() {
    await waitForDatabase();

    cron.start();

    const host = process.env.HOST || '127.0.0.1';
    app.listen(PORT, host, () => {
        console.log(`AskMak server listening on http://${host}:${PORT}/`);
    });
}

start();

const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const emailService = require('../services/email');
const db = require('../config/db');
const { authLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const { useSecureCookies } = require('../config/cookies');

const signupSchema = Joi.object({
    full_name: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(128).required()
});

const forgotPasswordSchema = Joi.object({
    email: Joi.string().email().required(),
    next: Joi.string().max(512).optional().allow('', null)
});

const resetPasswordSchema = Joi.object({
    token: Joi.string().trim().min(32).max(200).required(),
    password: Joi.string().min(8).max(128).required()
});

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashResetToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateResetToken() {
    return crypto.randomBytes(32).toString('hex');
}

/** Absolute origin for links in outbound email (reset, verify). */
function publicAppUrl(req) {
    const trimmed = process.env.PUBLIC_APP_URL && String(process.env.PUBLIC_APP_URL).trim();
    if (trimmed) return trimmed.replace(/\/$/, '');
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    if (!host) return `http://localhost:${process.env.PORT || 3000}`;
    return `${proto}://${host}`;
}

const FORGOT_PASSWORD_GENERIC =
    'If an account exists for that email, we sent a link to reset your password.';

function smtpConfigured() {
    return emailService.smtpConfigured();
}

/** When false (default except explicit "false"), do not skip sending if SMTP looks configured */
function verificationEmailDisabled() {
    return String(process.env.VERIFICATION_EMAIL || '').trim().toLowerCase() === 'false';
}

function signToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function setAuthCookie(res, token) {
    res.cookie('token', token, {
        httpOnly: true,
        secure: useSecureCookies(),
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    });
}

router.post('/signup', authLimiter, async (req, res, next) => {
    try {
        const { error, value } = signupSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const existing = await db.query('SELECT id FROM users WHERE email = $1', [value.email]);
        if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

        const wantsEmailVerify = smtpConfigured() && !verificationEmailDisabled();
        const isProduction = process.env.NODE_ENV === 'production';

        if (isProduction && !wantsEmailVerify) {
            return res.status(503).json({
                error:
                    'Registration unavailable: configure SMTP_HOST (and SMTP_FROM) on the server to send verification emails.'
            });
        }

        const passwordHash = await bcrypt.hash(value.password, 12);
        const code = generateCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        const insertResult = await db.query(
            `INSERT INTO users (full_name, email, password_hash, verification_code, verification_expires_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [value.full_name, value.email, passwordHash, code, expiresAt]
        );
        const newUserId = insertResult.rows[0].id;

        const html = `<p>Hi ${value.full_name},</p><p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 15 minutes.</p>`;
        if (wantsEmailVerify) {
            const emailSent = await emailService.sendMail(value.email, 'Verify your AskMak account', html);
            if (!emailSent) {
                await db.query('DELETE FROM users WHERE id = $1', [newUserId]);
                return res.status(503).json({
                    error:
                        'Could not send the verification email. Check SMTP settings, then try signing up again.'
                });
            }
        } else {
            console.warn(
                `[AskMak DEV] Verification code for ${value.email}: ${code} (set SMTP_HOST in production to send mail)`
            );
        }

        let message =
            'Account created. Check your email for the verification code. Enter it on the next screen.';
        if (!wantsEmailVerify) {
            message =
                'Account created. On this server SMTP is off (dev): the verification code was printed in the AskMak server logs.';
        }
        if (process.env.SMTP_INBOX_URL && wantsEmailVerify) {
            message += ' Mailpit/UI: ' + process.env.SMTP_INBOX_URL;
        }

        res.status(201).json({ message });
    } catch (err) {
        next(err);
    }
});

router.post('/verify', authLimiter, async (req, res, next) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

        const result = await db.query(
            `SELECT id, full_name, email, role, verification_code, verification_expires_at, email_verified
             FROM users WHERE email = $1`,
            [email]
        );

        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

        const user = result.rows[0];

        if (user.email_verified) return res.status(400).json({ error: 'This email is already verified. Sign in instead.' });

        if (user.verification_code !== code) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        if (new Date() > new Date(user.verification_expires_at)) {
            return res.status(400).json({ error: 'Verification code has expired' });
        }

        await db.query(
            `UPDATE users SET email_verified = TRUE, verification_code = NULL, verification_expires_at = NULL
             WHERE id = $1`,
            [user.id]
        );

        const token = signToken(user);
        setAuthCookie(res, token);

        res.json({ user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
    } catch (err) {
        next(err);
    }
});

router.post('/resend-verification', authLimiter, async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const wantsEmailVerify = smtpConfigured() && !verificationEmailDisabled();
        const isProduction = process.env.NODE_ENV === 'production';

        const result = await db.query(
            'SELECT id, full_name, email_verified, verification_code, verification_expires_at FROM users WHERE email = $1',
            [email]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        if (result.rows[0].email_verified) return res.status(400).json({ error: 'Email already verified' });

        if (isProduction && !wantsEmailVerify) {
            return res.status(503).json({
                error: 'Email resend unavailable: SMTP is not configured on the server.'
            });
        }

        const prevCode = result.rows[0].verification_code;
        const prevExp = result.rows[0].verification_expires_at;

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await db.query('UPDATE users SET verification_code = $1, verification_expires_at = $2 WHERE id = $3', [
            code,
            expiresAt,
            result.rows[0].id
        ]);

        const html = `<p>Hi ${result.rows[0].full_name},</p><p>Your new verification code is: <strong>${code}</strong></p><p>This code expires in 15 minutes.</p>`;

        if (wantsEmailVerify) {
            const emailSent = await emailService.sendMail(email, 'Verify your AskMak account', html);
            if (!emailSent) {
                await db.query(
                    'UPDATE users SET verification_code = $1, verification_expires_at = $2 WHERE id = $3',
                    [prevCode, prevExp, result.rows[0].id]
                );
                return res.status(503).json({
                    error: 'Could not send the verification email. Check SMTP settings and try again.'
                });
            }
        } else {
            console.warn(
                `[AskMak DEV] New verification code for ${email}: ${code} (set SMTP_HOST in production to send mail)`
            );
        }

        let message = 'Verification code sent. Check your email.';
        if (process.env.SMTP_INBOX_URL) message += ' ' + process.env.SMTP_INBOX_URL;

        res.json({ message });
    } catch (err) {
        next(err);
    }
});

router.post('/login', authLimiter, async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const result = await db.query(
            'SELECT id, full_name, email, password_hash, role, email_verified FROM users WHERE email = $1',
            [email]
        );

        if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });

        const user = result.rows[0];

        if (!user.email_verified) return res.status(403).json({ error: 'Please verify your email first' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

        const token = signToken(user);
        setAuthCookie(res, token);

        res.json({ user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role } });
    } catch (err) {
        next(err);
    }
});

router.post('/forgot-password', authLimiter, async (req, res, next) => {
    try {
        const { error, value } = forgotPasswordSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const wantsEmailVerify = smtpConfigured() && !verificationEmailDisabled();
        const isProduction = process.env.NODE_ENV === 'production';

        const emailInput = value.email.trim();
        const result = await db.query(
            'SELECT id, full_name, email FROM users WHERE LOWER(email) = LOWER($1)',
            [emailInput]
        );

        if (!result.rows.length) {
            return res.json({ message: FORGOT_PASSWORD_GENERIC });
        }

        const user = result.rows[0];

        if (isProduction && !wantsEmailVerify) {
            return res.status(503).json({
                error:
                    'Password reset by email is unavailable: configure SMTP_HOST (and SMTP_FROM) on the server.'
            });
        }

        const rawToken = generateResetToken();
        const tokenHash = hashResetToken(rawToken);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        await db.query(
            `UPDATE users SET password_reset_token_hash = $1, password_reset_expires_at = $2,
             updated_at = NOW() WHERE id = $3`,
            [tokenHash, expiresAt, user.id]
        );

        const origin = publicAppUrl(req);
        const rawNext = value.next && String(value.next).trim();
        const safeNext =
            rawNext && rawNext.charAt(0) === '/' && rawNext.charAt(1) !== '/'
                ? rawNext
                : '';
        const nextQs = safeNext ? `&next=${encodeURIComponent(safeNext)}` : '';
        const resetUrl = `${origin}/reset-password.html?token=${encodeURIComponent(rawToken)}${nextQs}`;

        const html = `<p>Hi ${user.full_name},</p>
<p>We received a request to reset your AskMak password.</p>
<p><a href="${resetUrl}">Reset your password</a></p>
<p>This link expires in one hour. If you did not ask for this, you can ignore this email.</p>
<p style="font-size:12px;color:#64748b">If the link does not work, copy and paste this URL into your browser:<br>${resetUrl}</p>`;

        if (wantsEmailVerify) {
            const sent = await sendVerificationMail(user.email, 'Reset your AskMak password', html);
            if (!sent) {
                await db.query(
                    'UPDATE users SET password_reset_token_hash = NULL, password_reset_expires_at = NULL, updated_at = NOW() WHERE id = $1',
                    [user.id]
                );
                return res.status(503).json({
                    error: 'Could not send the reset email. Check SMTP settings and try again.'
                });
            }
        } else {
            console.warn(`[AskMak DEV] Password reset link for ${user.email}: ${resetUrl}`);
        }

        let message = FORGOT_PASSWORD_GENERIC;
        if (!wantsEmailVerify) {
            message +=
                ' On this server SMTP is off (dev): the reset link was printed in the AskMak server logs.';
        }
        if (process.env.SMTP_INBOX_URL && wantsEmailVerify) {
            message += ' Mailpit/UI: ' + process.env.SMTP_INBOX_URL;
        }

        res.json({ message });
    } catch (err) {
        next(err);
    }
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
    try {
        const { error, value } = resetPasswordSchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const tokenHash = hashResetToken(value.token);

        const result = await db.query(
            `SELECT id FROM users
             WHERE password_reset_token_hash = $1
               AND password_reset_expires_at IS NOT NULL
               AND password_reset_expires_at > NOW()`,
            [tokenHash]
        );

        if (!result.rows.length) {
            return res.status(400).json({
                error: 'This reset link is invalid or has expired. Request a new one from the sign-in page.'
            });
        }

        const userId = result.rows[0].id;
        const passwordHash = await bcrypt.hash(value.password, 12);

        await db.query(
            `UPDATE users SET password_hash = $1,
             password_reset_token_hash = NULL,
             password_reset_expires_at = NULL,
             updated_at = NOW()
             WHERE id = $2`,
            [passwordHash, userId]
        );

        res.json({ message: 'Your password has been updated. You can sign in now.' });
    } catch (err) {
        next(err);
    }
});

router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
});

router.get('/me', requireAuth, async (req, res, next) => {
    try {
        const result = await db.query(
            'SELECT id, full_name, email, role, created_at FROM users WHERE id = $1',
            [req.user.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ user: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

module.exports = router;

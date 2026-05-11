const nodemailer = require('nodemailer');

function getMailTransport() {
    if (!process.env.SMTP_HOST) return null;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true';
    const opts = {
        host: process.env.SMTP_HOST,
        port,
        secure
    };
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        opts.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
    }
    if (port === 587 && !secure) {
        opts.requireTLS = true;
    }
    return nodemailer.createTransport(opts);
}

async function sendMail(to, subject, html) {
    const transport = getMailTransport();
    if (!transport) {
        console.warn(`[Email Service Dev] No SMTP configured. Target: ${to}, Subject: ${subject}`);
        console.log('HTML Content:', html);
        return true; // Simulate success in dev
    }
    try {
        await transport.sendMail({
            from: process.env.SMTP_FROM || '"AskMak" <noreply@localhost>',
            to,
            subject,
            html
        });
        return true;
    } catch (err) {
        console.error('Email send failed:', err.message);
        return false;
    }
}

module.exports = {
    sendMail,
    smtpConfigured: () => Boolean(process.env.SMTP_HOST && String(process.env.SMTP_HOST).trim())
};

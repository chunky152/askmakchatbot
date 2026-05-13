/**
 * Adds password_reset_* columns for forgot-password flow (existing Postgres DBs).
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const { Client } = require('pg');

const SQL_PATH = path.join(__dirname, '..', 'db', 'password_reset_columns.sql');

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set.');
        process.exit(1);
    }

    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
        await client.query(sql);
    } finally {
        await client.end();
    }

    console.log('Password reset columns applied.');
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});

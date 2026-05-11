require('dotenv').config();
const db = require('../config/db');

async function migrate() {
    try {
        console.log('Starting migration...');
        
        await db.query(`
            ALTER TABLE escalations ALTER COLUMN chat_id DROP NOT NULL;
            ALTER TABLE escalations ALTER COLUMN message_id DROP NOT NULL;
            
            ALTER TABLE escalations ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);
            ALTER TABLE escalations ADD COLUMN IF NOT EXISTS category VARCHAR(100);
            ALTER TABLE escalations ADD COLUMN IF NOT EXISTS title VARCHAR(512);
        `);
        
        console.log('Migration successful!');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();

-- Run once on existing databases (also appended at end of schema.sql for fresh installs).
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token_hash)
    WHERE password_reset_token_hash IS NOT NULL;

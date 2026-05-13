CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verification_code VARCHAR(10),
    verification_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    guest_token VARCHAR(255),
    title VARCHAR(255) DEFAULT 'New chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    tokens_used INTEGER DEFAULT 0,
    sources JSONB,
    confidence_score FLOAT,
    image_key VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_url VARCHAR(1024),
    title VARCHAR(512),
    content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    embedding vector(1536),
    category VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    image_keys JSONB,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_key VARCHAR(255) NOT NULL,
    memory_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escalations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'resolved', 'dismissed')),
    admin_response TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    guest_token VARCHAR(255),
    rating BOOLEAN NOT NULL,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, user_id),
    UNIQUE(message_id, guest_token)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_guest_token ON chats(guest_token);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source ON documents(source_url, chunk_index);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS tsv tsvector;
CREATE INDEX IF NOT EXISTS idx_documents_tsv ON documents USING gin(tsv);

CREATE OR REPLACE FUNCTION documents_tsv_trigger() RETURNS trigger AS $$
BEGIN
    NEW.tsv := setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
               setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_documents_tsv ON documents;
CREATE TRIGGER trg_documents_tsv
    BEFORE INSERT OR UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION documents_tsv_trigger();

-- ─── Rule-based Knowledge Base ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_entries (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category     VARCHAR(100)  NOT NULL,
    title        VARCHAR(512)  NOT NULL,
    content      TEXT          NOT NULL,
    is_published BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_entries_category  ON kb_entries(category);
CREATE INDEX IF NOT EXISTS idx_kb_entries_published ON kb_entries(is_published, category);

-- ─── Student Support Tickets ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_tickets (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category       VARCHAR(100)  NOT NULL,
    title          VARCHAR(512)  NOT NULL,
    content        TEXT,
    student_email  VARCHAR(255)  NOT NULL,
    student_name   VARCHAR(255),
    status         VARCHAR(20)   NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'resolved')),
    admin_response TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    resolved_at    TIMESTAMPTZ,
    notified_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_tickets_status ON kb_tickets(status);
CREATE INDEX IF NOT EXISTS idx_kb_tickets_email  ON kb_tickets(student_email);

-- Password reset (forgot-password flow); safe to run on existing DBs
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token_hash)
    WHERE password_reset_token_hash IS NOT NULL;

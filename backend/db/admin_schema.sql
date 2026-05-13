CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS admin_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'completed',
    stats JSONB DEFAULT '{}',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

INSERT INTO admin_settings (key, value) VALUES
('system_prompt', to_jsonb('You are AskMak, Makerere University support assistant.'::text)),
('confidence_escalation_threshold', '0.65'::jsonb),
('guest_rate_limit', '20'::jsonb),
('auth_rate_limit', '100'::jsonb),
('guest_mode_enabled', 'true'::jsonb),
('guest_chat_retention_days', '30'::jsonb),
('max_tool_depth', '3'::jsonb),
('allowed_fetch_domains', to_jsonb('*.mak.ac.ug'::text))
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_unresolved_dismissals (
    message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_reference_image_meta (
    object_key VARCHAR(1024) PRIMARY KEY,
    display_name VARCHAR(255),
    category VARCHAR(100),
    description TEXT,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Curated FAQ + support tickets (see also backend/db/schema.sql). Keeps migrations that only run admin_schema.sql in sync.
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

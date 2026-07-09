-- Real login-session tracking, distinct from the unused `user_sessions`
-- analytics telemetry table (screen views/crash counts, never referenced by
-- any route/service code -- do not confuse the two or repurpose it).
--
-- Each row is one issued JWT (identified by its `jti` claim), created at
-- login/signup and updated (last_active_at) as that token keeps getting
-- used/renewed. `revoked_at`/`revoked_reason` support later phases (real
-- logout, remote "terminate this session") -- this migration only adds the
-- table and starts recording; nothing enforces revocation yet.
CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    jti uuid NOT NULL UNIQUE,
    device_id text,
    device_type text,
    device_name text,
    ip_address inet,
    location_city text,
    location_country text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_reason text
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_jti ON auth_sessions (jti);

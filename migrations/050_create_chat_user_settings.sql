-- Create per-user chat settings for archive/pin
-- Safe to run multiple times (IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS chat_user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, chat_id)
);

-- Trigger to keep updated_at in sync
CREATE OR REPLACE FUNCTION set_updated_at_chat_user_settings()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_updated_at_chat_user_settings ON chat_user_settings;
CREATE TRIGGER trg_set_updated_at_chat_user_settings
BEFORE UPDATE ON chat_user_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at_chat_user_settings();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_chat_user_settings_user ON chat_user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_user_settings_chat ON chat_user_settings(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_user_settings_user_archived ON chat_user_settings(user_id, archived);
CREATE INDEX IF NOT EXISTS idx_chat_user_settings_user_pinned ON chat_user_settings(user_id, pinned);

-- RLS
ALTER TABLE chat_user_settings ENABLE ROW LEVEL SECURITY;

-- Policies
DO $$ BEGIN
  -- SELECT: users can read their own settings
  CREATE POLICY chat_user_settings_select ON chat_user_settings
    FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- INSERT/UPSERT: user can write only their own row
  CREATE POLICY chat_user_settings_insert ON chat_user_settings
    FOR INSERT WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- UPDATE: user can update only their own row
  CREATE POLICY chat_user_settings_update ON chat_user_settings
    FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- DELETE: user can delete only their own row
  CREATE POLICY chat_user_settings_delete ON chat_user_settings
    FOR DELETE USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

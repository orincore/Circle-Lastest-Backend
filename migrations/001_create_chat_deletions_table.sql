-- Create chat_deletions table for user-specific chat clearing
-- This allows users to clear chats for themselves without affecting other users

CREATE TABLE IF NOT EXISTS chat_deletions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- Ensure one deletion record per user per chat
  UNIQUE(chat_id, user_id)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_chat_deletions_chat_id ON chat_deletions(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_deletions_user_id ON chat_deletions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_deletions_deleted_at ON chat_deletions(deleted_at);

-- Add comments for documentation
COMMENT ON TABLE chat_deletions IS 'Tracks when users have cleared/deleted chats from their view';
COMMENT ON COLUMN chat_deletions.chat_id IS 'The chat that was cleared';
COMMENT ON COLUMN chat_deletions.user_id IS 'The user who cleared the chat';
COMMENT ON COLUMN chat_deletions.deleted_at IS 'When the user cleared the chat (used to filter messages)';

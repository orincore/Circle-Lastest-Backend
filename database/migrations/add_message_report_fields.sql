-- Migration: Add message reporting fields to user_reports table
-- This allows users to report specific messages in addition to users

-- Add message_id column to track which message was reported
ALTER TABLE user_reports 
ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- Add chat_id column to track which chat the report is from
ALTER TABLE user_reports 
ADD COLUMN IF NOT EXISTS chat_id UUID REFERENCES chats(id) ON DELETE SET NULL;

-- Add additional_details column for extra context
ALTER TABLE user_reports 
ADD COLUMN IF NOT EXISTS additional_details TEXT;

-- Create index for faster lookups by message_id
CREATE INDEX IF NOT EXISTS idx_user_reports_message_id ON user_reports(message_id) WHERE message_id IS NOT NULL;

-- Create index for faster lookups by chat_id
CREATE INDEX IF NOT EXISTS idx_user_reports_chat_id ON user_reports(chat_id) WHERE chat_id IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN user_reports.message_id IS 'The specific message being reported (optional)';
COMMENT ON COLUMN user_reports.chat_id IS 'The chat where the reported message/user was found (optional)';
COMMENT ON COLUMN user_reports.additional_details IS 'Additional context provided by the reporter (optional)';

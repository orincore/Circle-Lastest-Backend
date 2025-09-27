-- Database updates for message reactions, editing, and deletion features
-- Run these queries in your Supabase SQL editor

-- 1. Add new columns to existing messages table
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- 2. Create message_reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure a user can only react with the same emoji once per message
    UNIQUE(message_id, user_id, emoji)
);

-- 3. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id ON message_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_updated_at ON messages(updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages(is_deleted);

-- 4. Enable Row Level Security (RLS) for message_reactions
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- 5. Create RLS policies for message_reactions
-- Policy: Users can view reactions on messages they have access to
CREATE POLICY "Users can view message reactions" ON message_reactions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM messages m
            JOIN chat_members cm ON m.chat_id = cm.chat_id
            WHERE m.id = message_reactions.message_id 
            AND cm.user_id = auth.uid()
        )
    );

-- Policy: Users can add reactions to messages they have access to
CREATE POLICY "Users can add message reactions" ON message_reactions
    FOR INSERT WITH CHECK (
        user_id = auth.uid() AND
        EXISTS (
            SELECT 1 FROM messages m
            JOIN chat_members cm ON m.chat_id = cm.chat_id
            WHERE m.id = message_reactions.message_id 
            AND cm.user_id = auth.uid()
        )
    );

-- Policy: Users can delete their own reactions
CREATE POLICY "Users can delete their own reactions" ON message_reactions
    FOR DELETE USING (user_id = auth.uid());

-- 6. Update existing messages RLS policy to allow editing/deleting
-- First, drop the existing policy if it exists
DROP POLICY IF EXISTS "Users can update their own messages" ON messages;

-- Create new policy for message updates (edit/delete)
CREATE POLICY "Users can update their own messages" ON messages
    FOR UPDATE USING (sender_id = auth.uid())
    WITH CHECK (sender_id = auth.uid());

-- 7. Add trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for messages table
DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 8. Optional: Add some sample data for testing (remove in production)
-- INSERT INTO message_reactions (message_id, user_id, emoji) 
-- SELECT 
--     m.id as message_id,
--     auth.uid() as user_id,
--     '❤️' as emoji
-- FROM messages m 
-- LIMIT 1;

-- 9. Verify the setup with some test queries
-- Check if columns were added successfully
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'messages' 
-- AND column_name IN ('updated_at', 'is_edited', 'is_deleted');

-- Check if message_reactions table was created
-- SELECT table_name, column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'message_reactions' 
-- ORDER BY ordinal_position;

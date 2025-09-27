-- STEP 1: Add new columns to messages table
-- Run this first
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- STEP 2: Create message_reactions table
-- Run this second
CREATE TABLE IF NOT EXISTS message_reactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure a user can only react with the same emoji once per message
    UNIQUE(message_id, user_id, emoji)
);

-- STEP 3: Enable Row Level Security
-- Run this third
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- STEP 4: Create basic RLS policies
-- Run this fourth
CREATE POLICY "Users can view message reactions" ON message_reactions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM messages m
            JOIN chat_members cm ON m.chat_id = cm.chat_id
            WHERE m.id = message_reactions.message_id 
            AND cm.user_id = auth.uid()
        )
    );

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

CREATE POLICY "Users can delete their own reactions" ON message_reactions
    FOR DELETE USING (user_id = auth.uid());

-- STEP 5: Update messages table policy for editing
-- Run this fifth
DROP POLICY IF EXISTS "Users can update their own messages" ON messages;

CREATE POLICY "Users can update their own messages" ON messages
    FOR UPDATE USING (sender_id = auth.uid())
    WITH CHECK (sender_id = auth.uid());

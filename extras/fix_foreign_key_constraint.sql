-- Fix the foreign key constraint issue for message_reactions table
-- The issue is that the user_id references auth.users but your users might be in a different table

-- First, let's check what users table you're actually using
-- Run this to see all tables that might contain users:
SELECT table_name 
FROM information_schema.tables 
WHERE table_name LIKE '%user%' OR table_name LIKE '%profile%'
ORDER BY table_name;

-- Check what table your messages are referencing for sender_id
SELECT 
    tc.constraint_name, 
    tc.table_name, 
    kcu.column_name, 
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name 
FROM information_schema.table_constraints AS tc 
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
    AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' 
    AND tc.table_name = 'messages'
    AND kcu.column_name = 'sender_id';

-- Option 1: If you have a 'profiles' table, recreate message_reactions with correct reference
DROP TABLE IF EXISTS message_reactions;

CREATE TABLE message_reactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL, -- We'll add the constraint after checking what table to reference
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure a user can only react with the same emoji once per message
    UNIQUE(message_id, user_id, emoji)
);

-- Option 2: If your messages table references 'profiles' table, add this constraint:
-- ALTER TABLE message_reactions 
-- ADD CONSTRAINT message_reactions_user_id_fkey 
-- FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- Option 3: If you want to remove the foreign key constraint entirely (less safe but will work):
-- ALTER TABLE message_reactions DROP CONSTRAINT IF EXISTS message_reactions_user_id_fkey;

-- Enable RLS
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- Recreate the policies
DROP POLICY IF EXISTS "Users can view message reactions" ON message_reactions;
DROP POLICY IF EXISTS "Users can add message reactions" ON message_reactions;
DROP POLICY IF EXISTS "Users can delete their own reactions" ON message_reactions;

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

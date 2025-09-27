-- Verify that all database setup is complete
-- Run these queries to check everything is properly set up

-- 1. Check if new columns were added to messages table
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns 
WHERE table_name = 'messages' 
AND column_name IN ('updated_at', 'is_edited', 'is_deleted')
ORDER BY column_name;

-- 2. Check message_reactions table structure
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns 
WHERE table_name = 'message_reactions' 
ORDER BY ordinal_position;

-- 3. Check if RLS is enabled on message_reactions
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE tablename = 'message_reactions';

-- 4. Check RLS policies on message_reactions
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies 
WHERE tablename = 'message_reactions';

-- 5. Check if messages table has update policy
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies 
WHERE tablename = 'messages' AND cmd = 'UPDATE';

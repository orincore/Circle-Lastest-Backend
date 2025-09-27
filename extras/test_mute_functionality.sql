-- Test script to verify mute functionality is working
-- Run this in Supabase SQL Editor to test

-- 1. Check if the chat_mute_settings table exists
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'chat_mute_settings' 
ORDER BY ordinal_position;

-- 2. Check current mute settings (replace with actual user_id and chat_id)
-- SELECT * FROM chat_mute_settings 
-- WHERE user_id = 'your-user-id' AND chat_id = 'your-chat-id';

-- 3. Test inserting a mute setting (replace with actual IDs)
-- INSERT INTO chat_mute_settings (user_id, chat_id, is_muted) 
-- VALUES ('test-user-id', 'test-chat-id', true)
-- ON CONFLICT (user_id, chat_id) 
-- DO UPDATE SET is_muted = EXCLUDED.is_muted, updated_at = NOW();

-- 4. Verify the insert worked
-- SELECT * FROM chat_mute_settings 
-- WHERE user_id = 'test-user-id' AND chat_id = 'test-chat-id';

-- 5. Check RLS policies are working
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies 
WHERE tablename = 'chat_mute_settings';

-- 6. Test the RLS by trying to access as different user (should fail)
-- This should only return rows for the authenticated user
SELECT COUNT(*) as mute_settings_count FROM chat_mute_settings;

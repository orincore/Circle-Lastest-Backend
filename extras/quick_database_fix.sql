-- Quick fix to remove the foreign key constraint that's causing the error
-- Run this in your Supabase SQL Editor

ALTER TABLE message_reactions 
DROP CONSTRAINT IF EXISTS message_reactions_user_id_fkey;

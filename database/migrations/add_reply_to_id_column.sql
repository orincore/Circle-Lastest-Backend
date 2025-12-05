-- Migration: Add reply_to_id column to messages table for reply feature
-- Run this SQL in your Supabase SQL Editor

-- Add reply_to_id column to messages table
ALTER TABLE public.messages 
ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL;

-- Create index for faster lookups of replies
CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON public.messages(reply_to_id);

-- Add comment for documentation
COMMENT ON COLUMN public.messages.reply_to_id IS 'Reference to the message being replied to (for WhatsApp-style reply feature)';

-- Verify the column was added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'messages' AND column_name = 'reply_to_id';

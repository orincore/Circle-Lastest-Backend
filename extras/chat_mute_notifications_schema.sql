-- SQL to add mute notifications feature for chats
-- Run this in your Supabase SQL Editor

-- Create chat_mute_settings table
CREATE TABLE IF NOT EXISTS chat_mute_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    chat_id UUID NOT NULL,
    is_muted BOOLEAN DEFAULT FALSE,
    muted_until TIMESTAMP WITH TIME ZONE NULL, -- For temporary muting
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure one record per user per chat
    UNIQUE(user_id, chat_id)
);

-- Add RLS (Row Level Security) policies
ALTER TABLE chat_mute_settings ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own mute settings
CREATE POLICY "Users can view own mute settings" ON chat_mute_settings
    FOR SELECT USING (auth.uid() = user_id);

-- Policy: Users can insert their own mute settings
CREATE POLICY "Users can insert own mute settings" ON chat_mute_settings
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own mute settings
CREATE POLICY "Users can update own mute settings" ON chat_mute_settings
    FOR UPDATE USING (auth.uid() = user_id);

-- Policy: Users can delete their own mute settings
CREATE POLICY "Users can delete own mute settings" ON chat_mute_settings
    FOR DELETE USING (auth.uid() = user_id);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_chat_mute_settings_user_id ON chat_mute_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_mute_settings_chat_id ON chat_mute_settings(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_mute_settings_user_chat ON chat_mute_settings(user_id, chat_id);

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_chat_mute_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_chat_mute_settings_updated_at_trigger ON chat_mute_settings;
CREATE TRIGGER update_chat_mute_settings_updated_at_trigger
    BEFORE UPDATE ON chat_mute_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_chat_mute_settings_updated_at();

-- Insert some sample data (optional - remove if not needed)
-- INSERT INTO chat_mute_settings (user_id, chat_id, is_muted) 
-- VALUES 
--     ('user-id-1', 'chat-id-1', true),
--     ('user-id-2', 'chat-id-1', false);

-- Verify the table was created successfully
SELECT 
    table_name, 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'chat_mute_settings' 
ORDER BY ordinal_position;

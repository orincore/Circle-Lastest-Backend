-- Create message_receipts table for tracking delivery and read status
CREATE TABLE IF NOT EXISTS message_receipts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL CHECK (status IN ('delivered', 'read')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure one receipt per message per user
    UNIQUE(message_id, user_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_message_receipts_message_id ON message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_message_receipts_user_id ON message_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_message_receipts_status ON message_receipts(status);
CREATE INDEX IF NOT EXISTS idx_message_receipts_created_at ON message_receipts(created_at);

-- Add RLS policies
ALTER TABLE message_receipts ENABLE ROW LEVEL SECURITY;

-- Users can only see receipts for their own messages or receipts they created
CREATE POLICY "Users can view message receipts" ON message_receipts
    FOR SELECT USING (
        user_id = auth.uid() OR 
        message_id IN (
            SELECT id FROM messages WHERE sender_id = auth.uid()
        )
    );

-- Users can only create receipts for messages they received
CREATE POLICY "Users can create message receipts" ON message_receipts
    FOR INSERT WITH CHECK (
        user_id = auth.uid() AND
        message_id IN (
            SELECT id FROM messages WHERE sender_id != auth.uid()
        )
    );

-- Users can update their own receipts (e.g., delivered -> read)
CREATE POLICY "Users can update their own receipts" ON message_receipts
    FOR UPDATE USING (user_id = auth.uid());

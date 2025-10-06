-- Create AI conversations table for customer support
CREATE TABLE IF NOT EXISTS ai_conversations (
    id VARCHAR(255) PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    messages JSONB DEFAULT '[]'::jsonb,
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'escalated', 'resolved', 'abandoned')),
    intent VARCHAR(100) DEFAULT 'general',
    refund_explanation_count INTEGER DEFAULT 0,
    estimated_cost DECIMAL(10,6) DEFAULT 0.000000,
    token_count INTEGER DEFAULT 0,
    user_context JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_id ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_session_id ON ai_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_status ON ai_conversations(status);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_intent ON ai_conversations(intent);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_created_at ON ai_conversations(created_at);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_ai_conversation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS trigger_update_ai_conversation_updated_at ON ai_conversations;
CREATE TRIGGER trigger_update_ai_conversation_updated_at
    BEFORE UPDATE ON ai_conversations
    FOR EACH ROW
    EXECUTE FUNCTION update_ai_conversation_updated_at();

-- Add RLS (Row Level Security) policies
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own conversations
CREATE POLICY ai_conversations_user_policy ON ai_conversations
    FOR ALL USING (
        auth.uid() = user_id OR 
        auth.uid() IN (
            SELECT user_id FROM admin_roles WHERE is_active = true
        )
    );

-- Policy: Allow anonymous sessions (for non-logged-in users)
CREATE POLICY ai_conversations_anonymous_policy ON ai_conversations
    FOR ALL USING (
        user_id IS NULL OR
        auth.uid() = user_id OR 
        auth.uid() IN (
            SELECT user_id FROM admin_roles WHERE is_active = true
        )
    );

-- Grant permissions
GRANT ALL ON ai_conversations TO authenticated;
GRANT ALL ON ai_conversations TO anon;

-- Create analytics view for admins
CREATE OR REPLACE VIEW ai_conversation_analytics AS
SELECT 
    DATE_TRUNC('day', created_at) as date,
    status,
    intent,
    COUNT(*) as conversation_count,
    AVG(refund_explanation_count) as avg_refund_explanations,
    COUNT(CASE WHEN status = 'escalated' THEN 1 END) as escalations,
    COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolutions,
    COUNT(CASE WHEN user_id IS NULL THEN 1 END) as anonymous_conversations,
    COUNT(CASE WHEN user_id IS NOT NULL THEN 1 END) as authenticated_conversations,
    SUM(estimated_cost) as total_estimated_cost,
    AVG(estimated_cost) as avg_cost_per_conversation,
    SUM(token_count) as total_tokens,
    AVG(token_count) as avg_tokens_per_conversation
FROM ai_conversations 
GROUP BY DATE_TRUNC('day', created_at), status, intent
ORDER BY date DESC, status, intent;

-- Grant view access to admins
GRANT SELECT ON ai_conversation_analytics TO authenticated;

COMMENT ON TABLE ai_conversations IS 'Stores AI customer support conversation history and metadata';
COMMENT ON COLUMN ai_conversations.messages IS 'JSONB array of conversation messages with role, content, and timestamp';
COMMENT ON COLUMN ai_conversations.user_context IS 'JSONB object containing user subscription and profile information for personalized responses';
COMMENT ON COLUMN ai_conversations.refund_explanation_count IS 'Counter for how many times refund policy has been explained (max 3)';
COMMENT ON VIEW ai_conversation_analytics IS 'Analytics view for AI conversation metrics and performance tracking';

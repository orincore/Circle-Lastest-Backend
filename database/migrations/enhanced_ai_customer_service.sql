-- Enhanced AI Customer Service Database Schema
-- Run this migration to add all necessary tables for the advanced features

-- 1. Enhanced AI Conversations table (extend existing)
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS personality JSONB;
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS conversation_state JSONB;
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS sentiment_analysis JSONB;
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS detected_language VARCHAR(10);
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS escalation_level VARCHAR(20);
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS satisfaction_rating INTEGER CHECK (satisfaction_rating >= 1 AND satisfaction_rating <= 5);
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS proactive_alerts JSONB;

-- 2. Satisfaction Ratings table
CREATE TABLE IF NOT EXISTS satisfaction_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id VARCHAR REFERENCES ai_conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    feedback TEXT,
    category VARCHAR(50) NOT NULL DEFAULT 'overall',
    agent_type VARCHAR(10) NOT NULL DEFAULT 'ai' CHECK (agent_type IN ('ai', 'human')),
    agent_id VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Satisfaction Surveys table
CREATE TABLE IF NOT EXISTS satisfaction_surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id VARCHAR REFERENCES ai_conversations(id) ON DELETE CASCADE,
    questions JSONB NOT NULL,
    overall_score DECIMAL(3,2),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Survey Responses table
CREATE TABLE IF NOT EXISTS survey_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    survey_id UUID REFERENCES satisfaction_surveys(id) ON DELETE CASCADE,
    question_id VARCHAR(100) NOT NULL,
    answer TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Escalation Logs table
CREATE TABLE IF NOT EXISTS escalation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id VARCHAR REFERENCES ai_conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    escalation_reason TEXT NOT NULL,
    priority VARCHAR(20) NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    sentiment_score DECIMAL(3,2),
    assigned_agent VARCHAR(100),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Feedback Analysis table
CREATE TABLE IF NOT EXISTS feedback_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id VARCHAR REFERENCES ai_conversations(id) ON DELETE CASCADE,
    sentiment VARCHAR(20) NOT NULL CHECK (sentiment IN ('positive', 'negative', 'neutral')),
    themes JSONB,
    action_items JSONB,
    urgency VARCHAR(20) NOT NULL CHECK (urgency IN ('low', 'medium', 'high')),
    follow_up_required BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Follow-up Tasks table
CREATE TABLE IF NOT EXISTS follow_up_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id VARCHAR REFERENCES ai_conversations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    urgency VARCHAR(20) NOT NULL CHECK (urgency IN ('low', 'medium', 'high')),
    reason TEXT NOT NULL,
    action_items JSONB,
    scheduled_for TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    assigned_to VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Proactive Alerts table
CREATE TABLE IF NOT EXISTS proactive_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    message TEXT NOT NULL,
    suggested_action TEXT,
    preventive_message TEXT,
    timeframe VARCHAR(20) CHECK (timeframe IN ('immediate', 'within_24h', 'within_week')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'addressed', 'dismissed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Agent Capabilities table (for human agents)
CREATE TABLE IF NOT EXISTS agent_capabilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    languages TEXT[] DEFAULT ARRAY['en'],
    specialties TEXT[] DEFAULT ARRAY['general_support'],
    current_load INTEGER DEFAULT 0,
    max_load INTEGER DEFAULT 5,
    availability VARCHAR(20) DEFAULT 'offline' CHECK (availability IN ('available', 'busy', 'offline')),
    rating DECIMAL(3,2) DEFAULT 0.0,
    response_time INTEGER DEFAULT 5, -- in minutes
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Conversation Analytics table (for caching analytics)
CREATE TABLE IF NOT EXISTS conversation_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    total_conversations INTEGER DEFAULT 0,
    resolved_conversations INTEGER DEFAULT 0,
    escalated_conversations INTEGER DEFAULT 0,
    average_satisfaction DECIMAL(3,2) DEFAULT 0.0,
    average_response_time INTEGER DEFAULT 0,
    total_cost DECIMAL(10,2) DEFAULT 0.0,
    ai_efficiency_score INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(date)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_satisfaction_ratings_conversation_id ON satisfaction_ratings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_satisfaction_ratings_user_id ON satisfaction_ratings(user_id);
CREATE INDEX IF NOT EXISTS idx_satisfaction_ratings_created_at ON satisfaction_ratings(created_at);
CREATE INDEX IF NOT EXISTS idx_satisfaction_ratings_rating ON satisfaction_ratings(rating);

CREATE INDEX IF NOT EXISTS idx_escalation_logs_conversation_id ON escalation_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_escalation_logs_user_id ON escalation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_escalation_logs_priority ON escalation_logs(priority);
CREATE INDEX IF NOT EXISTS idx_escalation_logs_created_at ON escalation_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_user_id ON follow_up_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_scheduled_for ON follow_up_tasks(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_follow_up_tasks_status ON follow_up_tasks(status);

CREATE INDEX IF NOT EXISTS idx_proactive_alerts_user_id ON proactive_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_proactive_alerts_severity ON proactive_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_proactive_alerts_status ON proactive_alerts(status);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_detected_language ON ai_conversations(detected_language);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_escalation_level ON ai_conversations(escalation_level);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_satisfaction_rating ON ai_conversations(satisfaction_rating);

-- Create functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for automatic timestamp updates
CREATE TRIGGER update_satisfaction_ratings_updated_at BEFORE UPDATE ON satisfaction_ratings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_satisfaction_surveys_updated_at BEFORE UPDATE ON satisfaction_surveys FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_follow_up_tasks_updated_at BEFORE UPDATE ON follow_up_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_proactive_alerts_updated_at BEFORE UPDATE ON proactive_alerts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_agent_capabilities_updated_at BEFORE UPDATE ON agent_capabilities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample agent capabilities
INSERT INTO agent_capabilities (agent_id, name, languages, specialties, max_load, availability, rating, response_time) VALUES
('agent_001', 'Sarah Johnson', ARRAY['en'], ARRAY['general_support', 'billing_support'], 5, 'available', 4.8, 3),
('agent_002', 'Raj Patel', ARRAY['en', 'hi'], ARRAY['technical_support', 'premium_support'], 4, 'available', 4.9, 2),
('agent_003', 'Maria Garcia', ARRAY['en', 'es'], ARRAY['general_support', 'crisis_management'], 5, 'busy', 4.7, 5),
('agent_004', 'Ahmed Hassan', ARRAY['en', 'ar'], ARRAY['billing_support', 'premium_support'], 4, 'available', 4.6, 4),
('agent_005', 'Li Wei', ARRAY['en', 'zh'], ARRAY['technical_support', 'general_support'], 4, 'available', 4.5, 3)
ON CONFLICT (agent_id) DO NOTHING;

-- Create view for conversation analytics
CREATE OR REPLACE VIEW conversation_analytics_view AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_conversations,
    COUNT(*) FILTER (WHERE status = 'resolved') as resolved_conversations,
    COUNT(*) FILTER (WHERE status = 'escalated') as escalated_conversations,
    AVG(satisfaction_rating) as average_satisfaction,
    AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60) as average_response_time_minutes,
    SUM(estimated_cost) as total_cost,
    CASE 
        WHEN COUNT(*) > 0 THEN
            ROUND(
                (COUNT(*) FILTER (WHERE status = 'resolved')::FLOAT / COUNT(*) * 100 +
                 COALESCE(AVG(satisfaction_rating), 0) * 20 +
                 GREATEST(0, 100 - AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60))) / 3
            )
        ELSE 0
    END as ai_efficiency_score
FROM ai_conversations 
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Create view for real-time metrics
CREATE OR REPLACE VIEW real_time_metrics_view AS
SELECT 
    (SELECT COUNT(*) FROM ai_conversations WHERE status = 'active' AND updated_at >= NOW() - INTERVAL '30 minutes') as active_conversations,
    (SELECT COUNT(*) FROM ai_conversations WHERE status = 'active') as queue_length,
    (SELECT COUNT(*) FROM ai_conversations WHERE status = 'resolved' AND DATE(updated_at) = CURRENT_DATE) as issues_resolved_today,
    (SELECT COUNT(*) FROM ai_conversations WHERE status = 'escalated' AND DATE(created_at) = CURRENT_DATE) as escalations_today,
    (SELECT AVG(rating) FROM satisfaction_ratings WHERE created_at >= NOW() - INTERVAL '24 hours') as current_satisfaction_score,
    (SELECT AVG(current_load::FLOAT / max_load * 100) FROM agent_capabilities WHERE availability = 'available') as agent_utilization;

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_app_user;

-- Add comments for documentation
COMMENT ON TABLE satisfaction_ratings IS 'Stores customer satisfaction ratings for conversations';
COMMENT ON TABLE satisfaction_surveys IS 'Stores detailed satisfaction surveys with multiple questions';
COMMENT ON TABLE escalation_logs IS 'Tracks when and why conversations are escalated to human agents';
COMMENT ON TABLE feedback_analysis IS 'Stores AI analysis of customer feedback for insights';
COMMENT ON TABLE follow_up_tasks IS 'Manages follow-up tasks for customer service team';
COMMENT ON TABLE proactive_alerts IS 'Stores proactive alerts for potential customer issues';
COMMENT ON TABLE agent_capabilities IS 'Manages human agent capabilities and availability';
COMMENT ON TABLE conversation_analytics IS 'Caches daily conversation analytics for reporting';

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Enhanced AI Customer Service schema has been successfully created!';
    RAISE NOTICE 'Tables created: satisfaction_ratings, satisfaction_surveys, survey_responses, escalation_logs, feedback_analysis, follow_up_tasks, proactive_alerts, agent_capabilities, conversation_analytics';
    RAISE NOTICE 'Views created: conversation_analytics_view, real_time_metrics_view';
    RAISE NOTICE 'Indexes and triggers have been set up for optimal performance';
END $$;

-- =====================================================
-- Prompt-Based Giver/Receiver Matching System
-- Compatible with Supabase/PostgreSQL
-- Requires pgvector extension for vector similarity search
-- =====================================================

-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- =====================================================
-- TABLES
-- =====================================================

-- Table to store giver profiles with their capabilities
CREATE TABLE IF NOT EXISTS giver_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    is_available BOOLEAN DEFAULT TRUE,
    skills TEXT[], -- Array of skills the giver can help with
    interests TEXT[], -- User's interests from profile
    bio TEXT, -- User's bio/about section
    categories TEXT[], -- Help categories: ['career', 'relationships', 'health', 'tech', etc.]
    profile_embedding VECTOR(1536), -- Vector embedding of combined profile data
    total_helps_given INTEGER DEFAULT 0,
    average_rating DECIMAL(3, 2) DEFAULT 0.00,
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_giver_profile UNIQUE(user_id)
);

-- Table to store receiver help requests
CREATE TABLE IF NOT EXISTS help_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receiver_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL, -- What the receiver needs help with
    prompt_embedding VECTOR(1536), -- Vector embedding of the prompt
    status VARCHAR(20) DEFAULT 'searching' CHECK (status IN ('searching', 'matched', 'declined_all', 'completed', 'cancelled', 'expired')),
    matched_giver_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    chat_room_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    attempts_count INTEGER DEFAULT 0, -- Number of givers contacted
    declined_giver_ids UUID[], -- Array of giver IDs who declined
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour', -- 1-hour retry window
    matched_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table to track individual giver request attempts
CREATE TABLE IF NOT EXISTS giver_request_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    help_request_id UUID NOT NULL REFERENCES help_requests(id) ON DELETE CASCADE,
    giver_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    response_time_seconds INTEGER, -- Time taken to respond
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_request_attempt UNIQUE(help_request_id, giver_user_id)
);

-- Table to track help session ratings and feedback
CREATE TABLE IF NOT EXISTS help_session_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    help_request_id UUID NOT NULL REFERENCES help_requests(id) ON DELETE CASCADE,
    chat_room_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    receiver_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    giver_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    receiver_rating INTEGER CHECK (receiver_rating >= 1 AND receiver_rating <= 5),
    giver_rating INTEGER CHECK (giver_rating >= 1 AND giver_rating <= 5),
    receiver_feedback TEXT,
    giver_feedback TEXT,
    was_helpful BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_session_feedback UNIQUE(help_request_id)
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Indexes for giver_profiles
CREATE INDEX IF NOT EXISTS idx_giver_profiles_user_id ON giver_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_giver_profiles_available ON giver_profiles(is_available) WHERE is_available = TRUE;
CREATE INDEX IF NOT EXISTS idx_giver_profiles_categories ON giver_profiles USING GIN(categories);
CREATE INDEX IF NOT EXISTS idx_giver_profiles_skills ON giver_profiles USING GIN(skills);
CREATE INDEX IF NOT EXISTS idx_giver_profiles_embedding ON giver_profiles USING ivfflat (profile_embedding vector_cosine_ops) WITH (lists = 100);

-- Indexes for help_requests
CREATE INDEX IF NOT EXISTS idx_help_requests_receiver ON help_requests(receiver_user_id);
CREATE INDEX IF NOT EXISTS idx_help_requests_status ON help_requests(status);
CREATE INDEX IF NOT EXISTS idx_help_requests_active ON help_requests(status, expires_at) WHERE status = 'searching';
CREATE INDEX IF NOT EXISTS idx_help_requests_embedding ON help_requests USING ivfflat (prompt_embedding vector_cosine_ops) WITH (lists = 100);

-- Indexes for giver_request_attempts
CREATE INDEX IF NOT EXISTS idx_giver_attempts_help_request ON giver_request_attempts(help_request_id);
CREATE INDEX IF NOT EXISTS idx_giver_attempts_giver ON giver_request_attempts(giver_user_id);
CREATE INDEX IF NOT EXISTS idx_giver_attempts_status ON giver_request_attempts(status);

-- Indexes for help_session_feedback
CREATE INDEX IF NOT EXISTS idx_feedback_receiver ON help_session_feedback(receiver_user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_giver ON help_session_feedback(giver_user_id);

-- =====================================================
-- RPC FUNCTIONS
-- =====================================================

-- Function to find best matching giver for a receiver's prompt
CREATE OR REPLACE FUNCTION find_best_giver_match(
    p_prompt_embedding VECTOR(1536),
    p_receiver_user_id UUID,
    p_excluded_giver_ids UUID[] DEFAULT ARRAY[]::UUID[],
    p_limit INTEGER DEFAULT 1
)
RETURNS TABLE (
    giver_user_id UUID,
    similarity_score FLOAT,
    is_available BOOLEAN,
    total_helps_given INTEGER,
    average_rating DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        gp.user_id,
        1 - (gp.profile_embedding <=> p_prompt_embedding) AS similarity_score,
        gp.is_available,
        gp.total_helps_given,
        gp.average_rating
    FROM giver_profiles gp
    WHERE 
        gp.is_available = TRUE
        AND gp.user_id != p_receiver_user_id
        AND NOT (gp.user_id = ANY(p_excluded_giver_ids))
        -- Ensure giver is not blocked by receiver or vice versa
        AND NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.blocker_id = p_receiver_user_id AND b.blocked_id = gp.user_id)
               OR (b.blocker_id = gp.user_id AND b.blocked_id = p_receiver_user_id)
        )
    ORDER BY gp.profile_embedding <=> p_prompt_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to update giver profile embedding
CREATE OR REPLACE FUNCTION update_giver_profile_embedding(
    p_user_id UUID,
    p_embedding TEXT, -- Accept as TEXT and convert to vector
    p_skills TEXT[] DEFAULT NULL,
    p_categories TEXT[] DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_giver_id UUID;
BEGIN
    INSERT INTO giver_profiles (
        user_id,
        profile_embedding,
        skills,
        categories,
        is_available
    ) VALUES (
        p_user_id,
        p_embedding::VECTOR(1536),
        COALESCE(p_skills, ARRAY[]::TEXT[]),
        COALESCE(p_categories, ARRAY[]::TEXT[]),
        TRUE
    )
    ON CONFLICT (user_id) 
    DO UPDATE SET
        profile_embedding = p_embedding::VECTOR(1536),
        skills = COALESCE(p_skills, giver_profiles.skills),
        categories = COALESCE(p_categories, giver_profiles.categories),
        updated_at = NOW()
    RETURNING id INTO v_giver_id;
    
    RETURN v_giver_id;
END;
$$ LANGUAGE plpgsql;

-- Function to toggle giver availability
CREATE OR REPLACE FUNCTION toggle_giver_availability(
    p_user_id UUID,
    p_is_available BOOLEAN
)
RETURNS BOOLEAN AS $$
DECLARE
    v_updated BOOLEAN;
BEGIN
    UPDATE giver_profiles
    SET 
        is_available = p_is_available,
        last_active_at = NOW(),
        updated_at = NOW()
    WHERE user_id = p_user_id
    RETURNING TRUE INTO v_updated;
    
    RETURN COALESCE(v_updated, FALSE);
END;
$$ LANGUAGE plpgsql;

-- Function to create help request
CREATE OR REPLACE FUNCTION create_help_request(
    p_receiver_user_id UUID,
    p_prompt TEXT,
    p_prompt_embedding TEXT -- Accept as TEXT and convert to vector
)
RETURNS UUID AS $$
DECLARE
    v_request_id UUID;
BEGIN
    INSERT INTO help_requests (
        receiver_user_id,
        prompt,
        prompt_embedding,
        status,
        expires_at
    ) VALUES (
        p_receiver_user_id,
        p_prompt,
        p_prompt_embedding::VECTOR(1536),
        'searching',
        NOW() + INTERVAL '1 hour'
    )
    RETURNING id INTO v_request_id;
    
    RETURN v_request_id;
END;
$$ LANGUAGE plpgsql;

-- Function to record giver response
CREATE OR REPLACE FUNCTION record_giver_response(
    p_help_request_id UUID,
    p_giver_user_id UUID,
    p_accepted BOOLEAN
)
RETURNS BOOLEAN AS $$
DECLARE
    v_response_time INTEGER;
    v_sent_at TIMESTAMPTZ;
BEGIN
    -- Get the sent_at timestamp
    SELECT sent_at INTO v_sent_at
    FROM giver_request_attempts
    WHERE help_request_id = p_help_request_id
      AND giver_user_id = p_giver_user_id;
    
    -- Calculate response time in seconds
    v_response_time := EXTRACT(EPOCH FROM (NOW() - v_sent_at))::INTEGER;
    
    -- Update the attempt record
    UPDATE giver_request_attempts
    SET 
        status = CASE WHEN p_accepted THEN 'accepted' ELSE 'declined' END,
        responded_at = NOW(),
        response_time_seconds = v_response_time
    WHERE help_request_id = p_help_request_id
      AND giver_user_id = p_giver_user_id;
    
    -- If accepted, update help request
    IF p_accepted THEN
        UPDATE help_requests
        SET 
            status = 'matched',
            matched_giver_id = p_giver_user_id,
            matched_at = NOW(),
            updated_at = NOW()
        WHERE id = p_help_request_id;
    ELSE
        -- Add giver to declined list
        UPDATE help_requests
        SET 
            declined_giver_ids = array_append(declined_giver_ids, p_giver_user_id),
            attempts_count = attempts_count + 1,
            updated_at = NOW()
        WHERE id = p_help_request_id;
    END IF;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Function to get active help requests (for retry logic)
CREATE OR REPLACE FUNCTION get_active_help_requests()
RETURNS TABLE (
    request_id UUID,
    receiver_user_id UUID,
    prompt TEXT,
    prompt_embedding VECTOR(1536),
    declined_giver_ids UUID[],
    attempts_count INTEGER,
    created_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        hr.id,
        hr.receiver_user_id,
        hr.prompt,
        hr.prompt_embedding,
        hr.declined_giver_ids,
        hr.attempts_count,
        hr.created_at,
        hr.expires_at
    FROM help_requests hr
    WHERE hr.status = 'searching'
      AND hr.expires_at > NOW()
    ORDER BY hr.created_at ASC;
END;
$$ LANGUAGE plpgsql;

-- Function to expire old help requests
CREATE OR REPLACE FUNCTION expire_old_help_requests()
RETURNS INTEGER AS $$
DECLARE
    v_expired_count INTEGER;
BEGIN
    UPDATE help_requests
    SET 
        status = 'expired',
        updated_at = NOW()
    WHERE status = 'searching'
      AND expires_at <= NOW()
    RETURNING COUNT(*) INTO v_expired_count;
    
    RETURN COALESCE(v_expired_count, 0);
END;
$$ LANGUAGE plpgsql;

-- Function to update giver statistics after help session
CREATE OR REPLACE FUNCTION update_giver_statistics(
    p_giver_user_id UUID,
    p_rating INTEGER DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE giver_profiles
    SET 
        total_helps_given = total_helps_given + 1,
        average_rating = CASE 
            WHEN p_rating IS NOT NULL THEN 
                ((average_rating * total_helps_given) + p_rating) / (total_helps_given + 1)
            ELSE average_rating
        END,
        updated_at = NOW()
    WHERE user_id = p_giver_user_id;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_giver_profiles_updated_at
    BEFORE UPDATE ON giver_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_help_requests_updated_at
    BEFORE UPDATE ON help_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_help_session_feedback_updated_at
    BEFORE UPDATE ON help_session_feedback
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE giver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE giver_request_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_session_feedback ENABLE ROW LEVEL SECURITY;

-- Giver profiles policies
CREATE POLICY "Users can view all giver profiles"
    ON giver_profiles FOR SELECT
    USING (TRUE);

CREATE POLICY "Users can insert their own giver profile"
    ON giver_profiles FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own giver profile"
    ON giver_profiles FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own giver profile"
    ON giver_profiles FOR DELETE
    USING (auth.uid() = user_id);

-- Help requests policies
CREATE POLICY "Users can view their own help requests"
    ON help_requests FOR SELECT
    USING (auth.uid() = receiver_user_id OR auth.uid() = matched_giver_id);

CREATE POLICY "Users can create their own help requests"
    ON help_requests FOR INSERT
    WITH CHECK (auth.uid() = receiver_user_id);

CREATE POLICY "Users can update their own help requests"
    ON help_requests FOR UPDATE
    USING (auth.uid() = receiver_user_id);

-- Giver request attempts policies
CREATE POLICY "Givers can view requests sent to them"
    ON giver_request_attempts FOR SELECT
    USING (auth.uid() = giver_user_id);

CREATE POLICY "System can insert giver request attempts"
    ON giver_request_attempts FOR INSERT
    WITH CHECK (TRUE);

CREATE POLICY "Givers can update their own attempts"
    ON giver_request_attempts FOR UPDATE
    USING (auth.uid() = giver_user_id);

-- Help session feedback policies
CREATE POLICY "Participants can view feedback for their sessions"
    ON help_session_feedback FOR SELECT
    USING (auth.uid() = receiver_user_id OR auth.uid() = giver_user_id);

CREATE POLICY "Participants can insert feedback"
    ON help_session_feedback FOR INSERT
    WITH CHECK (auth.uid() = receiver_user_id OR auth.uid() = giver_user_id);

CREATE POLICY "Participants can update their own feedback"
    ON help_session_feedback FOR UPDATE
    USING (auth.uid() = receiver_user_id OR auth.uid() = giver_user_id);

-- =====================================================
-- UTILITY VIEWS
-- =====================================================

-- View for giver leaderboard
CREATE OR REPLACE VIEW giver_leaderboard AS
SELECT 
    gp.user_id,
    p.username,
    p.first_name,
    p.last_name,
    gp.total_helps_given,
    gp.average_rating,
    gp.is_available,
    gp.categories,
    gp.skills
FROM giver_profiles gp
JOIN profiles p ON p.id = gp.user_id
WHERE gp.total_helps_given > 0
ORDER BY gp.total_helps_given DESC, gp.average_rating DESC
LIMIT 100;

-- View for active help requests summary
CREATE OR REPLACE VIEW active_help_requests_summary AS
SELECT 
    hr.id,
    hr.receiver_user_id,
    p.username AS receiver_username,
    hr.prompt,
    hr.status,
    hr.attempts_count,
    hr.created_at,
    hr.expires_at,
    EXTRACT(EPOCH FROM (hr.expires_at - NOW())) / 60 AS minutes_remaining
FROM help_requests hr
JOIN profiles p ON p.id = hr.receiver_user_id
WHERE hr.status = 'searching'
  AND hr.expires_at > NOW()
ORDER BY hr.created_at ASC;

-- =====================================================
-- COMMENTS FOR DOCUMENTATION
-- =====================================================

COMMENT ON TABLE giver_profiles IS 'Stores profiles of users who can help others (givers) with vector embeddings for matching';
COMMENT ON TABLE help_requests IS 'Stores help requests from receivers with prompt embeddings and matching status';
COMMENT ON TABLE giver_request_attempts IS 'Tracks individual attempts to match a receiver with givers';
COMMENT ON TABLE help_session_feedback IS 'Stores ratings and feedback after help sessions complete';

COMMENT ON FUNCTION find_best_giver_match IS 'Finds the best matching giver using vector similarity search';
COMMENT ON FUNCTION create_help_request IS 'Creates a new help request with 1-hour expiry';
COMMENT ON FUNCTION record_giver_response IS 'Records whether a giver accepted or declined a help request';
COMMENT ON FUNCTION get_active_help_requests IS 'Returns all active help requests for retry logic';
COMMENT ON FUNCTION expire_old_help_requests IS 'Marks help requests as expired after 1 hour';

-- =====================================================
-- END OF SCHEMA
-- =====================================================

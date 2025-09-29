-- Create complete friend request and friendship system tables
-- This includes all necessary tables, relationships, and policies

-- 1. Create friend_requests table
CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate requests between same users
    UNIQUE(sender_id, recipient_id),
    
    -- Prevent self-requests
    CHECK (sender_id != recipient_id)
);

-- 2. Create friendships table
CREATE TABLE IF NOT EXISTS friendships (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user1_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user2_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure consistent ordering (user1_id < user2_id)
    CHECK (user1_id < user2_id),
    
    -- Prevent duplicate friendships
    UNIQUE(user1_id, user2_id)
);

-- 3. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_id ON friend_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient_id ON friend_requests(recipient_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_status ON friend_requests(status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_created_at ON friend_requests(created_at);

CREATE INDEX IF NOT EXISTS idx_friendships_user1_id ON friendships(user1_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user2_id ON friendships(user2_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);
CREATE INDEX IF NOT EXISTS idx_friendships_created_at ON friendships(created_at);

-- 4. Create composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient_status ON friend_requests(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_status ON friend_requests(sender_id, status);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

-- 6. Create RLS policies for friend_requests
-- Users can view requests they sent or received
CREATE POLICY "Users can view their friend requests" ON friend_requests
    FOR SELECT USING (
        sender_id = auth.uid() OR recipient_id = auth.uid()
    );

-- Users can create friend requests (as sender)
CREATE POLICY "Users can send friend requests" ON friend_requests
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND sender_id != recipient_id
    );

-- Users can update requests they received (accept/decline)
CREATE POLICY "Recipients can update friend requests" ON friend_requests
    FOR UPDATE USING (recipient_id = auth.uid())
    WITH CHECK (recipient_id = auth.uid());

-- Users can delete requests they sent
CREATE POLICY "Senders can delete friend requests" ON friend_requests
    FOR DELETE USING (sender_id = auth.uid());

-- 7. Create RLS policies for friendships
-- Users can view friendships they're part of
CREATE POLICY "Users can view their friendships" ON friendships
    FOR SELECT USING (
        user1_id = auth.uid() OR user2_id = auth.uid()
    );

-- System can create friendships (usually done by backend)
CREATE POLICY "System can create friendships" ON friendships
    FOR INSERT WITH CHECK (true);

-- Users can update friendships they're part of (e.g., block)
CREATE POLICY "Users can update their friendships" ON friendships
    FOR UPDATE USING (
        user1_id = auth.uid() OR user2_id = auth.uid()
    );

-- Users can delete friendships they're part of
CREATE POLICY "Users can delete their friendships" ON friendships
    FOR DELETE USING (
        user1_id = auth.uid() OR user2_id = auth.uid()
    );

-- 8. Create helper functions
-- Function to get all friends of a user
CREATE OR REPLACE FUNCTION get_user_friends(user_uuid UUID)
RETURNS TABLE (
    friend_id UUID,
    friend_name TEXT,
    friend_email TEXT,
    friend_photo TEXT,
    friendship_created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        CASE 
            WHEN f.user1_id = user_uuid THEN f.user2_id
            ELSE f.user1_id
        END as friend_id,
        CASE 
            WHEN f.user1_id = user_uuid THEN CONCAT(p2.first_name, ' ', p2.last_name)
            ELSE CONCAT(p1.first_name, ' ', p1.last_name)
        END as friend_name,
        CASE 
            WHEN f.user1_id = user_uuid THEN p2.email
            ELSE p1.email
        END as friend_email,
        CASE 
            WHEN f.user1_id = user_uuid THEN p2.profile_photo_url
            ELSE p1.profile_photo_url
        END as friend_photo,
        f.created_at as friendship_created_at
    FROM friendships f
    JOIN profiles p1 ON f.user1_id = p1.id
    JOIN profiles p2 ON f.user2_id = p2.id
    WHERE (f.user1_id = user_uuid OR f.user2_id = user_uuid)
      AND f.status = 'active';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if two users are friends
CREATE OR REPLACE FUNCTION are_users_friends(user1_uuid UUID, user2_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM friendships 
        WHERE ((user1_id = user1_uuid AND user2_id = user2_uuid) 
            OR (user1_id = user2_uuid AND user2_id = user1_uuid))
          AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Create triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
CREATE TRIGGER update_friend_requests_updated_at
    BEFORE UPDATE ON friend_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_friendships_updated_at
    BEFORE UPDATE ON friendships
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 10. Insert some sample data for testing (optional)
-- Uncomment below to add test data

/*
-- Sample friend requests (replace with actual user IDs from your profiles table)
INSERT INTO friend_requests (sender_id, recipient_id, message, status) VALUES
    ('user-id-1', 'user-id-2', 'Hi! I would like to connect with you.', 'pending'),
    ('user-id-3', 'user-id-1', 'Hello! Let''s be friends.', 'pending')
ON CONFLICT (sender_id, recipient_id) DO NOTHING;
*/

-- 11. Grant necessary permissions
-- Grant usage on sequences
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

-- Grant permissions on tables
GRANT SELECT, INSERT, UPDATE, DELETE ON friend_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON friendships TO authenticated;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION get_user_friends(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION are_users_friends(UUID, UUID) TO authenticated;

-- 12. Verify table creation
SELECT 
    table_name,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name IN ('friend_requests', 'friendships')
ORDER BY table_name, ordinal_position;

-- 13. Verify foreign key relationships
SELECT
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
    AND tc.table_name IN ('friend_requests', 'friendships');

COMMENT ON TABLE friend_requests IS 'Stores friend requests between users with status tracking';
COMMENT ON TABLE friendships IS 'Stores active friendships between users';
COMMENT ON FUNCTION get_user_friends(UUID) IS 'Returns all friends of a given user';
COMMENT ON FUNCTION are_users_friends(UUID, UUID) IS 'Checks if two users are friends';

-- MANUAL SETUP: Run this SQL directly in your Supabase SQL Editor
-- This creates the essential friend request system tables

-- 1. Create friend_requests table
CREATE TABLE IF NOT EXISTS friend_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sender_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT fk_friend_requests_sender FOREIGN KEY (sender_id) REFERENCES profiles(id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_requests_recipient FOREIGN KEY (recipient_id) REFERENCES profiles(id) ON DELETE CASCADE,
    CONSTRAINT check_friend_requests_status CHECK (status IN ('pending', 'accepted', 'declined')),
    CONSTRAINT check_no_self_request CHECK (sender_id != recipient_id),
    CONSTRAINT unique_friend_request UNIQUE(sender_id, recipient_id)
);

-- 2. Create friendships table  
CREATE TABLE IF NOT EXISTS friendships (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user1_id UUID NOT NULL,
    user2_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT fk_friendships_user1 FOREIGN KEY (user1_id) REFERENCES profiles(id) ON DELETE CASCADE,
    CONSTRAINT fk_friendships_user2 FOREIGN KEY (user2_id) REFERENCES profiles(id) ON DELETE CASCADE,
    CONSTRAINT check_friendships_status CHECK (status IN ('active', 'blocked')),
    CONSTRAINT check_user_order CHECK (user1_id < user2_id),
    CONSTRAINT unique_friendship UNIQUE(user1_id, user2_id)
);

-- 3. Create indexes
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient_status ON friend_requests(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(user1_id, user2_id);

-- 4. Enable RLS
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

-- 5. Create basic RLS policies
CREATE POLICY "Users can view their friend requests" ON friend_requests
    FOR SELECT USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE POLICY "Users can send friend requests" ON friend_requests
    FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "Recipients can update requests" ON friend_requests
    FOR UPDATE USING (recipient_id = auth.uid());

CREATE POLICY "Users can view their friendships" ON friendships
    FOR SELECT USING (user1_id = auth.uid() OR user2_id = auth.uid());

CREATE POLICY "System can create friendships" ON friendships
    FOR INSERT WITH CHECK (true);

-- 6. Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON friend_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON friendships TO authenticated;

-- 7. Test the setup
SELECT 'friend_requests table created' as status 
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'friend_requests');

SELECT 'friendships table created' as status
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'friendships');

-- 8. Test the foreign key relationship that was failing
SELECT 
    tc.constraint_name,
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS references_table,
    ccu.column_name AS references_field
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu 
    ON tc.constraint_catalog = kcu.constraint_catalog
    AND tc.constraint_schema = kcu.constraint_schema
    AND tc.constraint_name = kcu.constraint_name
LEFT JOIN information_schema.referential_constraints rc 
    ON tc.constraint_catalog = rc.constraint_catalog
    AND tc.constraint_schema = rc.constraint_schema
    AND tc.constraint_name = rc.constraint_name
LEFT JOIN information_schema.constraint_column_usage ccu 
    ON rc.unique_constraint_catalog = ccu.constraint_catalog
    AND rc.unique_constraint_schema = ccu.constraint_schema
    AND rc.unique_constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name IN ('friend_requests', 'friendships');

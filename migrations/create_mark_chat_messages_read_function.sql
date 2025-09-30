-- Create an efficient stored procedure to mark all messages in a chat as read
-- This eliminates the need to fetch messages first, then insert receipts

CREATE OR REPLACE FUNCTION mark_chat_messages_read(
  p_chat_id UUID,
  p_user_id UUID
) RETURNS INTEGER AS $$
DECLARE
  affected_rows INTEGER;
BEGIN
  -- Insert read receipts for all messages in the chat that don't already have read receipts
  -- This is much more efficient than fetching messages first
  INSERT INTO message_receipts (message_id, user_id, status, created_at, updated_at)
  SELECT 
    m.id,
    p_user_id,
    'read',
    NOW(),
    NOW()
  FROM messages m
  WHERE m.chat_id = p_chat_id
    AND NOT EXISTS (
      SELECT 1 FROM message_receipts mr 
      WHERE mr.message_id = m.id 
        AND mr.user_id = p_user_id 
        AND mr.status = 'read'
    )
  ON CONFLICT (message_id, user_id, status) DO NOTHING;
  
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  
  -- Also ensure delivery receipts exist for all messages
  INSERT INTO message_receipts (message_id, user_id, status, created_at, updated_at)
  SELECT 
    m.id,
    p_user_id,
    'delivered',
    NOW(),
    NOW()
  FROM messages m
  WHERE m.chat_id = p_chat_id
    AND NOT EXISTS (
      SELECT 1 FROM message_receipts mr 
      WHERE mr.message_id = m.id 
        AND mr.user_id = p_user_id 
        AND mr.status = 'delivered'
    )
  ON CONFLICT (message_id, user_id, status) DO NOTHING;
  
  RETURN affected_rows;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission to the service role
GRANT EXECUTE ON FUNCTION mark_chat_messages_read(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION mark_chat_messages_read(UUID, UUID) TO authenticated;

-- Create an index to optimize the function performance if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_message_receipts_user_message_status 
ON message_receipts (user_id, message_id, status);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at 
ON messages (chat_id, created_at DESC);

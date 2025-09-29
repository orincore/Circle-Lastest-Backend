-- Add test message receipts to simulate delivered/read status
-- Based on the logs, we have these messages:

-- Add delivered receipt for your message from the other user
INSERT INTO message_receipts (message_id, user_id, status) 
VALUES ('a458c72e-3094-427b-8be7-c832b55f75a0', '8ccd6396-3d6f-475d-abac-a3a0a0aea279', 'delivered')
ON CONFLICT (message_id, user_id) DO UPDATE SET status = 'delivered';

-- Add read receipt for the same message (this will upgrade it to 'read' status)
INSERT INTO message_receipts (message_id, user_id, status)
VALUES ('a458c72e-3094-427b-8be7-c832b55f75a0', '8ccd6396-3d6f-475d-abac-a3a0a0aea279', 'read')
ON CONFLICT (message_id, user_id) DO UPDATE SET status = 'read';

-- Verify the receipts were added
SELECT mr.message_id, mr.user_id, mr.status, m.text, m.sender_id
FROM message_receipts mr
JOIN messages m ON mr.message_id = m.id
WHERE mr.message_id = 'a458c72e-3094-427b-8be7-c832b55f75a0';

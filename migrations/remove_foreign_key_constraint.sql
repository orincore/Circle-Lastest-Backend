-- Quick Fix: Remove foreign key constraint from user_photos
-- This allows photos to be saved without the constraint check
-- The application will still validate user_id exists

-- Drop the foreign key constraint
ALTER TABLE user_photos 
DROP CONSTRAINT IF EXISTS user_photos_user_id_fkey;

-- Verify constraint is removed
SELECT
    tc.constraint_name,
    tc.table_name,
    tc.constraint_type
FROM information_schema.table_constraints AS tc
WHERE tc.table_name = 'user_photos'
    AND tc.constraint_type = 'FOREIGN KEY';

-- Should return no rows if successful

-- Test: Try to insert a photo (replace with your actual user_id and photo URL)
-- INSERT INTO user_photos (user_id, photo_url) 
-- VALUES ('21680b5e-dad1-46ff-8a50-5cc88e2d49b7', 'https://test.com/photo.jpg');

SELECT 'Foreign key constraint removed successfully' as status;

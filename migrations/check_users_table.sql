-- Check where users table exists and find the user
-- Run this to diagnose the issue

-- Check all tables named 'users' in all schemas
SELECT 
    table_schema,
    table_name,
    table_type
FROM information_schema.tables 
WHERE table_name = 'users'
ORDER BY table_schema;

-- Check if user exists in auth.users
SELECT 
    'auth.users' as table_name,
    id, 
    email,
    created_at
FROM auth.users 
WHERE id = '21680b5e-dad1-46ff-8a50-5cc88e2d49b7'
LIMIT 1;

-- Check if user exists in public.users
SELECT 
    'public.users' as table_name,
    id,
    email,
    created_at
FROM public.users 
WHERE id = '21680b5e-dad1-46ff-8a50-5cc88e2d49b7'
LIMIT 1;

-- Show current foreign key constraint on user_photos
SELECT
    tc.constraint_name,
    tc.table_name,
    kcu.column_name,
    ccu.table_schema AS foreign_table_schema,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name = 'user_photos';

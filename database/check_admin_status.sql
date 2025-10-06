-- Check if your user has admin access
-- Replace 'your-email@example.com' with your actual email

-- 1. Check if your user exists in profiles table
SELECT 
    id,
    email,
    first_name,
    last_name,
    created_at
FROM profiles 
WHERE email = 'orincore@gmail.com';  -- Replace with your email

-- 2. Check if your user has admin role
SELECT 
    ar.id,
    ar.role,
    ar.is_active,
    ar.granted_at,
    ar.revoked_at,
    p.email,
    p.first_name
FROM admin_roles ar
JOIN profiles p ON ar.user_id = p.id
WHERE p.email = 'orincore@gmail.com';  -- Replace with your email

-- 3. Check all active admin users
SELECT 
    ar.role,
    p.email,
    p.first_name,
    p.last_name,
    ar.granted_at,
    ar.is_active
FROM admin_roles ar
JOIN profiles p ON ar.user_id = p.id
WHERE ar.is_active = TRUE
ORDER BY ar.granted_at DESC;

-- 4. If your user exists but has no admin role, add it:
-- Uncomment and run this if needed:
/*
INSERT INTO admin_roles (user_id, role, granted_at, is_active)
SELECT 
    p.id,
    'super_admin',
    NOW(),
    TRUE
FROM profiles p 
WHERE p.email = 'orincore@gmail.com'  -- Replace with your email
ON CONFLICT (user_id, role) DO UPDATE SET
    is_active = TRUE,
    revoked_at = NULL;
*/

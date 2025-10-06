-- Quick Admin User Setup
-- Replace 'your-email@example.com' with your actual email address

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

-- Verify the admin user was added
SELECT 
    ar.role,
    p.email,
    p.first_name,
    p.last_name,
    ar.granted_at,
    ar.is_active
FROM admin_roles ar
JOIN profiles p ON ar.user_id = p.id
WHERE p.email = 'orincore@gmail.com'  -- Replace with your email
AND ar.is_active = TRUE;

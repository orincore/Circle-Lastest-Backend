-- Add Admin Users to admin_roles table
-- Run this script to grant admin access to specific users

-- First, make sure the admin_roles table exists
CREATE TABLE IF NOT EXISTS admin_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'moderator', 'support')),
    granted_by UUID REFERENCES profiles(id),
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES profiles(id),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, role) -- Prevent duplicate roles for same user
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_admin_roles_user_id ON admin_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_roles_active ON admin_roles(is_active);
CREATE INDEX IF NOT EXISTS idx_admin_roles_role ON admin_roles(role);

-- Add admin users (replace email addresses with actual user emails)
-- Method 1: Grant admin role by email (recommended)
INSERT INTO admin_roles (user_id, role, granted_at, is_active)
SELECT 
    p.id,
    'super_admin',
    NOW(),
    TRUE
FROM profiles p 
WHERE p.email IN (
    'orincore@gmail.com',
    'admin@circle.com',
    'support@circle.com'
    -- Add more admin emails here
)
ON CONFLICT (user_id, role) DO UPDATE SET
    is_active = TRUE,
    revoked_at = NULL,

-- Method 2: Grant admin role by user ID (if you know the specific user IDs)
-- Uncomment and replace with actual user IDs if needed
/*
INSERT INTO admin_roles (user_id, role, granted_at, is_active)
VALUES 
    ('user-id-1', 'super_admin', NOW(), TRUE),
    ('user-id-2', 'admin', NOW(), TRUE),
    ('user-id-3', 'moderator', NOW(), TRUE)
ON CONFLICT (user_id, role) DO UPDATE SET
    is_active = TRUE,
    revoked_at = NULL,
*/

-- Verify admin users were added
SELECT 
    ar.id,
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

-- Optional: Grant admin role to a specific user by email (run individually)
-- Replace 'your-email@example.com' with the actual email
/*
INSERT INTO admin_roles (user_id, role, granted_at, is_active)
SELECT 
    p.id,
    'admin',
    NOW(),
    TRUE
FROM profiles p 
WHERE p.email = 'your-email@example.com'
ON CONFLICT (user_id, role) DO UPDATE SET
    is_active = TRUE,
    revoked_at = NULL,
*/

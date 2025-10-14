-- Fix user_photos foreign key constraint
-- Run this to fix the foreign key issue

-- Drop existing table if it exists
DROP TABLE IF EXISTS user_photos CASCADE;

-- Recreate table without auth.users reference
CREATE TABLE user_photos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    photo_url TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT valid_photo_url CHECK (photo_url ~ '^https?://.*')
);

-- Add foreign key - try different options based on your schema
-- Option 1: If users table is in public schema
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
        ALTER TABLE user_photos 
        ADD CONSTRAINT user_photos_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
        RAISE NOTICE 'Foreign key added to public.users';
    END IF;
END $$;

-- Option 2: If users table is in auth schema (Supabase)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
        ALTER TABLE user_photos 
        ADD CONSTRAINT user_photos_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
        RAISE NOTICE 'Foreign key added to auth.users';
    END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_photos_user_id ON user_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_photos_created_at ON user_photos(created_at DESC);

-- Enable Row Level Security
ALTER TABLE user_photos ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own photos
CREATE POLICY "Users can view their own photos" ON user_photos
    FOR SELECT
    USING (user_id = auth.uid());

-- RLS Policy: Users can view other users' photos (public gallery)
CREATE POLICY "Users can view other users photos" ON user_photos
    FOR SELECT
    USING (true);

-- RLS Policy: Users can insert their own photos
CREATE POLICY "Users can insert their own photos" ON user_photos
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- RLS Policy: Users can delete their own photos
CREATE POLICY "Users can delete their own photos" ON user_photos
    FOR DELETE
    USING (user_id = auth.uid());

-- RLS Policy: Users can update their own photos
CREATE POLICY "Users can update their own photos" ON user_photos
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_photos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS update_user_photos_updated_at_trigger ON user_photos;
CREATE TRIGGER update_user_photos_updated_at_trigger
    BEFORE UPDATE ON user_photos
    FOR EACH ROW
    EXECUTE FUNCTION update_user_photos_updated_at();

-- Verify setup
SELECT 
    'user_photos table created' as status,
    COUNT(*) as row_count
FROM user_photos;

-- Show foreign key constraints
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
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name
    AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name = 'user_photos';

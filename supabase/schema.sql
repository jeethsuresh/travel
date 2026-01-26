-- ============================================
-- TRAVEL LOCATION TRACKER - DATABASE SCHEMA
-- ============================================
-- Run this entire file in Supabase SQL Editor to set up the database
-- This includes tables, indexes, RLS policies, and storage configuration

-- ============================================
-- LOCATIONS TABLE
-- ============================================

-- Create locations table
CREATE TABLE IF NOT EXISTS locations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on user_id for faster queries
CREATE INDEX IF NOT EXISTS locations_user_id_idx ON locations(user_id);

-- Create index on timestamp for faster sorting
CREATE INDEX IF NOT EXISTS locations_timestamp_idx ON locations(timestamp DESC);

-- Enable Row Level Security
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Users can view their own locations" ON locations;
DROP POLICY IF EXISTS "Users can insert their own locations" ON locations;
DROP POLICY IF EXISTS "Users can delete their own locations" ON locations;

-- Create policy: Users can only see their own locations
CREATE POLICY "Users can view their own locations"
  ON locations
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Create policy: Users can insert their own locations
CREATE POLICY "Users can insert their own locations"
  ON locations
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Create policy: Users can delete their own locations
CREATE POLICY "Users can delete their own locations"
  ON locations
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================
-- PHOTOS TABLE
-- ============================================

-- Create photos table
CREATE TABLE IF NOT EXISTS photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on user_id for faster queries
CREATE INDEX IF NOT EXISTS photos_user_id_idx ON photos(user_id);

-- Create index on timestamp for faster sorting
CREATE INDEX IF NOT EXISTS photos_timestamp_idx ON photos(timestamp DESC);

-- Enable Row Level Security
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Users can view their own photos" ON photos;
DROP POLICY IF EXISTS "Users can insert their own photos" ON photos;
DROP POLICY IF EXISTS "Users can delete their own photos" ON photos;

-- Create policy: Users can only see their own photos
CREATE POLICY "Users can view their own photos"
  ON photos
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Create policy: Users can insert their own photos
CREATE POLICY "Users can insert their own photos"
  ON photos
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Create policy: Users can delete their own photos
CREATE POLICY "Users can delete their own photos"
  ON photos
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================
-- STORAGE BUCKET FOR PHOTOS
-- ============================================

-- Create storage bucket for photos (if it doesn't exist)
-- Set to private for security - we use signed URLs for access
INSERT INTO storage.buckets (id, name, public)
VALUES ('photos', 'photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- ============================================
-- STORAGE POLICIES
-- ============================================

-- Drop existing storage policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Users can upload their own photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can view their own photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own photos" ON storage.objects;

-- Create policy to allow authenticated users to upload photos
CREATE POLICY "Users can upload their own photos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Create policy to allow users to view their own photos
CREATE POLICY "Users can view their own photos"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Create policy to allow users to delete their own photos
CREATE POLICY "Users can delete their own photos"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Create policy to prevent unauthorized updates (users can only update their own photos)
CREATE POLICY "Users can update their own photos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================
-- VERIFICATION QUERIES (Optional - for testing)
-- ============================================
-- Uncomment and run these to verify everything is set up correctly

-- Check if tables exist and RLS is enabled
-- SELECT 
--   tablename,
--   rowsecurity as rls_enabled
-- FROM pg_tables 
-- WHERE schemaname = 'public' AND tablename IN ('locations', 'photos');

-- List all policies on tables
-- SELECT 
--   tablename,
--   policyname,
--   cmd as operation
-- FROM pg_policies 
-- WHERE tablename IN ('locations', 'photos')
-- ORDER BY tablename, policyname;

-- List storage policies
-- SELECT 
--   policyname,
--   cmd::text as operation
-- FROM pg_policies 
-- WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE '%photos%'
-- ORDER BY policyname;

-- Test auth.uid() (run while authenticated)
-- SELECT auth.uid() as current_user_id;

-- Verify you can see your own data (run while authenticated)
-- SELECT 
--   'locations' as table_name,
--   COUNT(*) as record_count
-- FROM locations 
-- WHERE user_id = auth.uid()
-- UNION ALL
-- SELECT 
--   'photos' as table_name,
--   COUNT(*) as record_count
-- FROM photos 
-- WHERE user_id = auth.uid();

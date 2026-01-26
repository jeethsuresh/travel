    -- ============================================
    -- MIGRATION: Add wait_time to locations table
    -- ============================================
    -- This migration adds the wait_time column to track how long users
    -- stay at a location, and enables location updates via RLS policy.
    -- 
    -- Run this in Supabase SQL Editor
    -- Safe to run multiple times (idempotent)
    -- ============================================

    -- Add wait_time column if it doesn't exist
    DO $$ 
    BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'locations' 
        AND column_name = 'wait_time'
    ) THEN
        ALTER TABLE locations 
        ADD COLUMN wait_time INTEGER NOT NULL DEFAULT 0;
        
        -- Set wait_time to 0 for all existing rows (they were created before this feature)
        UPDATE locations 
        SET wait_time = 0 
        WHERE wait_time IS NULL;
        
        RAISE NOTICE 'Added wait_time column to locations table';
    ELSE
        RAISE NOTICE 'wait_time column already exists, skipping';
    END IF;
    END $$;

    -- Add UPDATE policy if it doesn't exist
    DO $$
    BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_policies 
        WHERE schemaname = 'public' 
        AND tablename = 'locations' 
        AND policyname = 'Users can update their own locations'
    ) THEN
        CREATE POLICY "Users can update their own locations"
        ON locations
        FOR UPDATE
        TO authenticated
        USING (auth.uid() = user_id)
        WITH CHECK (auth.uid() = user_id);
        
        RAISE NOTICE 'Added UPDATE policy for locations table';
    ELSE
        RAISE NOTICE 'UPDATE policy already exists, skipping';
    END IF;
    END $$;

    -- Verify the migration
    SELECT 
    'Migration completed successfully' as status,
    EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'locations' 
        AND column_name = 'wait_time'
    ) as wait_time_column_exists,
    EXISTS (
        SELECT 1 
        FROM pg_policies 
        WHERE schemaname = 'public' 
        AND tablename = 'locations' 
        AND policyname = 'Users can update their own locations'
    ) as update_policy_exists;


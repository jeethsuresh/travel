-- ============================================
-- MIGRATION: Friends & Friend Requests
-- ============================================
-- This migration adds tables and RLS policies to support:
-- - Sending friend requests by email
-- - Receiving and acting on friend requests
-- - A simple friends list for each user
--
-- Run this in the Supabase SQL Editor.
-- The migration is written to be safe to run multiple times (idempotent).
-- ============================================

-- ============================================
-- FRIEND REQUESTS TABLE
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename  = 'friend_requests'
  ) THEN
    CREATE TABLE public.friend_requests (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

      -- User who initiated the request
      requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      requester_email TEXT NOT NULL,

      -- Recipient is identified by email so requests can be created
      -- even before the user signs up. When the recipient signs up
      -- with this email, they will immediately see pending requests.
      recipient_email TEXT NOT NULL,

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),

      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    );

    CREATE INDEX friend_requests_requester_id_idx
      ON public.friend_requests(requester_id);

    CREATE INDEX friend_requests_recipient_email_idx
      ON public.friend_requests(recipient_email);

    CREATE INDEX friend_requests_status_idx
      ON public.friend_requests(status);
  END IF;
END $$;

-- Avoid duplicate pending requests from the same requester to the same email.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname  = 'friend_requests_unique_pending_idx'
  ) THEN
    CREATE UNIQUE INDEX friend_requests_unique_pending_idx
      ON public.friend_requests (requester_id, recipient_email)
      WHERE status = 'pending';
  END IF;
END $$;

-- Enable RLS
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotency)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'friend_requests'
  ) THEN
    DROP POLICY IF EXISTS "FriendRequests select for requester or recipient" ON public.friend_requests;
    DROP POLICY IF EXISTS "FriendRequests insert by requester" ON public.friend_requests;
    DROP POLICY IF EXISTS "FriendRequests update by recipient" ON public.friend_requests;
    DROP POLICY IF EXISTS "FriendRequests delete by requester" ON public.friend_requests;
  END IF;
END $$;

-- Helper: current JWT email (Supabase exposes this via auth.jwt())
-- We use it so that recipients can see requests addressed to their email.

CREATE OR REPLACE FUNCTION public.current_jwt_email()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((auth.jwt() ->> 'email')::text, NULL::text);
$$;

-- Select: requester sees their requests; recipient sees requests sent to their email.
CREATE POLICY "FriendRequests select for requester or recipient"
  ON public.friend_requests
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = requester_id
    OR public.current_jwt_email() = recipient_email
  );

-- Insert: only the authenticated requester can create a request on their own behalf.
CREATE POLICY "FriendRequests insert by requester"
  ON public.friend_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = requester_id
    AND requester_email = public.current_jwt_email()
  );

-- Update: only the recipient (by email) may update status (accept/reject).
CREATE POLICY "FriendRequests update by recipient"
  ON public.friend_requests
  FOR UPDATE
  TO authenticated
  USING (
    public.current_jwt_email() = recipient_email
  )
  WITH CHECK (
    public.current_jwt_email() = recipient_email
  );

-- Delete: allow the requester to cancel their own requests.
CREATE POLICY "FriendRequests delete by requester"
  ON public.friend_requests
  FOR DELETE
  TO authenticated
  USING (auth.uid() = requester_id);


-- ============================================
-- FRIENDSHIPS TABLE
-- ============================================
-- We store one row per direction:
--   user_id -> friend_id
-- so each user has a simple "my friends" list.
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename  = 'friendships'
  ) THEN
    CREATE TABLE public.friendships (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

      user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      friend_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      friend_email TEXT NOT NULL,

      -- When true, this user is allowing friend_id to see this user's
      -- latest location on the map.
      share_location_with_friend BOOLEAN NOT NULL DEFAULT FALSE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX friendships_user_id_idx
      ON public.friendships(user_id);

    CREATE INDEX friendships_friend_id_idx
      ON public.friendships(friend_id);
  END IF;
END $$;

-- Ensure the share_location_with_friend column exists even if the table
-- was created before this migration was added.
ALTER TABLE public.friendships
  ADD COLUMN IF NOT EXISTS share_location_with_friend BOOLEAN NOT NULL DEFAULT FALSE;

-- Prevent duplicate friendships in a single direction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname  = 'friendships_unique_user_friend_idx'
  ) THEN
    CREATE UNIQUE INDEX friendships_unique_user_friend_idx
      ON public.friendships (user_id, friend_id);
  END IF;
END $$;

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotency)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'friendships'
  ) THEN
    DROP POLICY IF EXISTS "Friendships select own" ON public.friendships;
    DROP POLICY IF EXISTS "Friendships insert own" ON public.friendships;
    DROP POLICY IF EXISTS "Friendships delete own" ON public.friendships;
  END IF;
END $$;

CREATE POLICY "Friendships select own"
  ON public.friendships
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- A user can only insert friendships that involve themselves.
-- This allows inserting both directions (user -> friend and friend -> user)
-- when the current user is one side of the friendship.
CREATE POLICY "Friendships insert own"
  ON public.friendships
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    OR auth.uid() = friend_id
  );

-- A user can update only their own friendships (e.g. toggle share_location_with_friend).
CREATE POLICY "Friendships update own"
  ON public.friendships
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- A user can delete only their own friendships (e.g. unfriend).
CREATE POLICY "Friendships delete own"
  ON public.friendships
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ============================================
-- OPTIONAL: Helper view for debugging (commented out)
-- ============================================
-- CREATE OR REPLACE VIEW public.friend_requests_debug AS
-- SELECT
--   id,
--   requester_id,
--   requester_email,
--   recipient_email,
--   status,
--   created_at,
--   responded_at
-- FROM public.friend_requests;


-- ============================================
-- FRIENDS' LATEST LOCATIONS RPC
-- ============================================
-- Returns the latest location for each friend who has enabled
-- share_location_with_friend = TRUE towards the current user.
--
-- This is implemented as a SECURITY DEFINER function so it can
-- read from friendships/locations even though RLS on locations
-- normally only allows self-reads. The function itself enforces
-- that only friends who opted in are returned, using auth.uid().
-- ============================================

CREATE OR REPLACE FUNCTION public.get_friends_latest_locations()
RETURNS TABLE (
  friend_id UUID,
  friend_email TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  "timestamp" TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.user_id AS friend_id,
    u.email AS friend_email,
    l.latitude,
    l.longitude,
    l.timestamp
  FROM public.friendships f
  JOIN auth.users u
    ON u.id = f.user_id
  JOIN LATERAL (
    SELECT latitude, longitude, timestamp
    FROM public.locations
    WHERE user_id = f.user_id
    ORDER BY timestamp DESC
    LIMIT 1
  ) l ON TRUE
  WHERE
    f.friend_id = auth.uid()
    AND f.share_location_with_friend = TRUE
$$;



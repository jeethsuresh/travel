"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import dynamicImport from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import Auth from "@/components/Auth";
import LocationHistory from "@/components/LocationHistory";
import PhotoGallery from "@/components/PhotoGallery";
import type { User } from "@supabase/supabase-js";
import { getPendingLocationsForUser, getPendingPhotosForUser, deletePendingLocation } from "@/lib/localStore";
import { Preferences } from "@capacitor/preferences";
import { App } from "@capacitor/app";
import { isNativePlatform } from "@/lib/capacitor";

// Dynamically import Map component to prevent SSR issues with Leaflet
const Map = dynamicImport(() => import("@/components/Map"), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full">Loading map...</div>,
});

interface Location {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time?: number;
}

interface Photo {
  id: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
}

interface PhotoWithLocation {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  storage_path: string;
  url?: string;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [photos, setPhotos] = useState<PhotoWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusLocation, setFocusLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const pendingPhotoUrlsRef = useRef<globalThis.Map<string, string>>(new globalThis.Map());

  // Lazy initialization of Supabase client to avoid issues during build
  const supabase = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return createClient();
  }, []);

  useEffect(() => {
    if (!supabase) return;
    
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  const fetchLocations = useCallback(async () => {
    console.log("[Location:page] fetchLocations 1. Entry", { hasUser: !!user, hasSupabase: !!supabase });
    if (!user || !supabase) {
      console.log("[Location:page] fetchLocations 1b. Early return: no user or supabase");
      setLocations([]);
      return;
    }

    try {
      console.log("[Location:page] fetchLocations 2. Fetching remote + pending");
      const [remoteResult, pendingList] = await Promise.all([
        supabase
          .from("locations")
          .select("*")
          .eq("user_id", user.id)
          .order("timestamp", { ascending: true }),
        getPendingLocationsForUser(user.id),
      ]);

      if (remoteResult.error) {
        console.log("[Location:page] fetchLocations 2. Remote error", remoteResult.error);
        throw remoteResult.error;
      }

      const remote = remoteResult.data || [];
      const pendingAsLocations: Location[] = pendingList.map((p) => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: p.timestamp,
        wait_time: p.wait_time,
      }));

      const merged = [...remote, ...pendingAsLocations].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      console.log("[Location:page] fetchLocations 3. Merged", { remoteCount: remote.length, pendingCount: pendingList.length, mergedCount: merged.length, ids: merged.map((l) => l.id) });
      setLocations(merged);
      console.log("[Location:page] fetchLocations 4. setLocations(merged) called");
    } catch (error) {
      console.error("[Location:page] fetchLocations Error:", error);
    }
  }, [user, supabase]);

  // Sync pending locations to Supabase (upload then remove from local). Used by 5-min background interval.
  const syncPendingLocationsToSupabase = useCallback(async () => {
    if (!user || !supabase) return;
    try {
      const pending = await getPendingLocationsForUser(user.id);
      if (pending.length === 0) return;
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser || authUser.id !== user.id) return;
      for (const loc of pending) {
        const { error } = await supabase
          .from("locations")
          .insert({
            user_id: loc.user_id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            timestamp: loc.timestamp,
            wait_time: loc.wait_time,
          });
        if (!error) await deletePendingLocation(loc.id);
      }
      fetchLocations();
    } catch (e) {
      console.warn("[Location:sync] Background sync failed", e);
    }
  }, [user, supabase, fetchLocations]);

  // Upload pending locations in the background every 5 minutes
  useEffect(() => {
    if (!user || !supabase) return;
    const intervalMs = 5 * 60 * 1000;
    const id = setInterval(syncPendingLocationsToSupabase, intervalMs);
    return () => clearInterval(id);
  }, [user, supabase, syncPendingLocationsToSupabase]);

  // Sync pending + auth to Preferences so Background Runner can upload when OS runs the task (iOS/Android)
  const syncPendingToPreferencesForRunner = useCallback(async () => {
    if (!isNativePlatform() || !user || !supabase) return;
    try {
      const pending = await getPendingLocationsForUser(user.id);
      const { data: { session } } = await supabase.auth.getSession();
      if (pending.length > 0 && session?.access_token) {
        await Preferences.set({
          key: "travel.pending",
          value: JSON.stringify(pending),
        });
        await Preferences.set({
          key: "travel.supabaseAuth",
          value: JSON.stringify({
            url: process.env.NEXT_PUBLIC_SUPABASE_URL,
            anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
            accessToken: session.access_token,
          }),
        });
      }
    } catch (e) {
      console.warn("[Location:Preferences] sync for runner failed", e);
    }
  }, [user, supabase]);

  // On app background: write pending to Preferences for Background Runner. On app active: apply uploadedIds from runner.
  useEffect(() => {
    if (!isNativePlatform()) return;
    const listenerPromise = App.addListener("appStateChange", async (state) => {
      if (state.isActive) {
        try {
          const { value } = await Preferences.get({ key: "travel.uploadedIds" });
          if (value) {
            const ids = JSON.parse(value) as string[];
            for (const id of ids) await deletePendingLocation(id);
            await Preferences.remove({ key: "travel.uploadedIds" });
            fetchLocations();
          }
        } catch (e) {
          console.warn("[Location:uploadedIds] apply failed", e);
        }
      } else {
        await syncPendingToPreferencesForRunner();
      }
    });
    return () => { listenerPromise.then((l) => l.remove()).catch(() => {}); };
  }, [syncPendingToPreferencesForRunner, fetchLocations]);

  const fetchPhotos = useCallback(async () => {
    if (!user || !supabase) {
      setPhotos([]);
      return;
    }

    try {
      const [remoteResult, pendingList] = await Promise.all([
        supabase
          .from("photos")
          .select("id, latitude, longitude, timestamp, storage_path")
          .eq("user_id", user.id)
          .not("latitude", "is", null)
          .not("longitude", "is", null)
          .order("timestamp", { ascending: false }),
        getPendingPhotosForUser(user.id),
      ]);

      if (remoteResult.error) throw remoteResult.error;

      const remote = (remoteResult.data || []).filter(
        (photo): photo is PhotoWithLocation =>
          photo.latitude !== null && photo.longitude !== null
      );

      pendingPhotoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingPhotoUrlsRef.current.clear();

      const pendingPhotos: PhotoWithLocation[] = pendingList
        .filter((p) => p.latitude != null && p.longitude != null)
        .map((p) => {
          const url = URL.createObjectURL(p.blob);
          pendingPhotoUrlsRef.current.set(p.id, url);
          return {
            id: p.id,
            latitude: p.latitude!,
            longitude: p.longitude!,
            timestamp: p.timestamp,
            storage_path: "",
            url,
          };
        });

      const merged = [...pendingPhotos, ...remote].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setPhotos(merged);
    } catch (error) {
      console.error("Error fetching photos:", error);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (user) {
      fetchLocations();
      fetchPhotos();
    } else {
      setLocations([]);
      setPhotos([]);
    }
  }, [user, fetchLocations, fetchPhotos]);

  useEffect(() => {
    return () => {
      pendingPhotoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingPhotoUrlsRef.current.clear();
    };
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold mb-6 text-gray-900 dark:text-gray-100">
          Travel Location Tracker
        </h1>

        <div className="mb-6">
          <Auth />
        </div>

        {user && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
              <div className="lg:col-span-2">
                <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md overflow-hidden" style={{ height: "600px" }}>
                  <Map
                    user={user}
                    locations={locations.map((loc) => ({
                      lat: loc.latitude,
                      lng: loc.longitude,
                      timestamp: loc.timestamp,
                    }))}
                    photos={photos}
                    onLocationUpdate={fetchLocations}
                    focusLocation={focusLocation}
                  />
                </div>
              </div>
              <div>
                <LocationHistory
                  user={user}
                  locations={locations}
                  onLocationSelect={(location) => {
                    setFocusLocation({
                      latitude: location.latitude,
                      longitude: location.longitude,
                    });
                  }}
                  onRefresh={fetchLocations}
                />
              </div>
            </div>
            <div>
              <PhotoGallery 
                user={user} 
                onPhotoClick={(photo) => {
                  if (photo.latitude && photo.longitude) {
                    setFocusLocation({
                      latitude: photo.latitude,
                      longitude: photo.longitude,
                    });
                  }
                }}
                onPhotosUpdate={fetchPhotos}
              />
            </div>
          </>
        )}

        {!user && (
          <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
            <p>Sign in to start tracking your location history</p>
          </div>
        )}
      </div>
    </div>
  );
}

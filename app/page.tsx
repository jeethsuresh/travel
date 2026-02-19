"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import dynamicImport from "next/dynamic";
import { createClient } from "@/lib/firebase/client";
import { onAuthStateChanged } from "firebase/auth";
import Auth from "@/components/Auth";
import Friends from "@/components/Friends";
import LocationHistory from "@/components/LocationHistory";
import PhotoGallery from "@/components/PhotoGallery";
import type { User as FirebaseUser } from "firebase/auth";
import { getPendingLocationsForUser, getPendingPhotosForUser, deletePendingLocation } from "@/lib/localStore";
import { getAllLocalPhotosForUser, getLocalPhotoUrl } from "@/lib/localPhotoStorage";
import { getPhotoMetadataForUser } from "@/lib/firebase/photos";
import { collection, query, where, orderBy, limit, getDocs, addDoc, Timestamp } from "firebase/firestore";
import { Preferences } from "@capacitor/preferences";
import { App } from "@capacitor/app";
import { BackgroundRunner } from "@capacitor/background-runner";
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

interface FriendLocation {
  friend_id: string;
  friend_email: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}

export default function Home() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationsHasMore, setLocationsHasMore] = useState<boolean>(true);
  const [locationsLoadingMore, setLocationsLoadingMore] = useState<boolean>(false);
  const [photos, setPhotos] = useState<PhotoWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusLocation, setFocusLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [friendLocations, setFriendLocations] = useState<FriendLocation[]>([]);
  const pendingPhotoUrlsRef = useRef<globalThis.Map<string, string>>(new globalThis.Map());
  const isLoadingMoreRef = useRef<boolean>(false);
  const locationsRef = useRef<Location[]>([]);

  // Lazy initialization of Firebase client to avoid issues during build
  const { auth, db } = useMemo(() => {
    if (typeof window === 'undefined') {
      return { auth: null, db: null };
    }
    return createClient();
  }, []);

  useEffect(() => {
    if (!auth) return;
    
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [auth]);

  const LOCATIONS_PAGE_SIZE = 10;

  const LOCATIONS_CACHE_KEY = "travel_locations_cache";

  /** Persist locations to localStorage so they survive reload. */
  const persistLocations = useCallback((userId: string, locs: Location[]) => {
    if (typeof window === "undefined" || !locs.length) return;
    try {
      localStorage.setItem(
        `${LOCATIONS_CACHE_KEY}_${userId}`,
        JSON.stringify(locs)
      );
    } catch (e) {
      console.warn("Failed to persist locations to localStorage", e);
    }
  }, []);

  /** Restore locations from localStorage for the current user (used on reload). */
  const restoreLocationsFromCache = useCallback((userId: string): Location[] => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(`${LOCATIONS_CACHE_KEY}_${userId}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Location[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, []);

  /**
   * Fetch a page of locations (remote + pending), newest first.
   * - On initial load we fetch only the latest 10 rows from Supabase to avoid pulling the full history.
   * - As the user scrolls the history list, we load additional pages of 10 using the timestamp cursor.
   */
  const fetchLocations = useCallback(
    async ({ reset = false }: { reset?: boolean } = {}) => {
      console.log("[Location:page] fetchLocations 1. Entry", {
        hasUser: !!user,
        hasDb: !!db,
        reset,
      });
      if (!user || !db) {
        console.log(
          "[Location:page] fetchLocations 1b. Early return: no user or db"
        );
        setLocations([]);
        setLocationsHasMore(false);
        return;
      }

      // Prevent overlapping "load more" requests using ref.
      // This guard and the loading flag only apply to non-reset "Load More" calls
      // so that automatic refreshes (initial load, syncs) don't flip the button
      // label to "Loading more..." or look like user-initiated pagination.
      if (!reset) {
        if (isLoadingMoreRef.current) {
          console.log("[Location:page] fetchLocations - already loading, skipping");
          return;
        }
        isLoadingMoreRef.current = true;
        setLocationsLoadingMore(true);
      }

      try {
        console.log(
          "[Location:page] fetchLocations 2. Fetching remote page + pending"
        );

        // For pagination we always order by timestamp DESC so the newest items are first.
        // When not resetting, request items strictly older than the last one we already have.
        // Use ref to get current locations without causing dependency issues
        const currentLocations = reset ? [] : locationsRef.current;
        const lastKnownOldest =
          currentLocations.length > 0
            ? currentLocations[currentLocations.length - 1]
            : null;

        let locationsQuery = query(
          collection(db, "locations"),
          where("user_id", "==", user.uid),
          orderBy("timestamp", "desc"),
          limit(LOCATIONS_PAGE_SIZE + 1) // fetch one extra row to detect hasMore
        );

        // Note: Firestore doesn't support lt() with orderBy on different fields easily
        // For now, we'll fetch and filter client-side. For better performance, consider
        // using a timestamp-based cursor or composite index.
        const [remoteSnapshot, pendingList] = await Promise.all([
          getDocs(locationsQuery),
          getPendingLocationsForUser(user.uid),
        ]);

        let remoteDesc = remoteSnapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            latitude: data.latitude,
            longitude: data.longitude,
            timestamp: data.timestamp instanceof Timestamp 
              ? data.timestamp.toDate().toISOString() 
              : data.timestamp,
            wait_time: data.wait_time || 0,
          };
        });

        // Filter by timestamp if paginating
        if (!reset && lastKnownOldest) {
          remoteDesc = remoteDesc.filter(
            (loc) => new Date(loc.timestamp).getTime() < new Date(lastKnownOldest!.timestamp).getTime()
          );
        }

        const hasMore = remoteDesc.length > LOCATIONS_PAGE_SIZE;
        const pageRemoteDesc = remoteDesc.slice(0, LOCATIONS_PAGE_SIZE);

        setLocationsHasMore(hasMore);

        const pendingAsLocations: Location[] = pendingList.map((p) => ({
          id: p.id,
          latitude: p.latitude,
          longitude: p.longitude,
          timestamp: p.timestamp,
          wait_time: p.wait_time,
        }));

        // Merge new page + pending into existing list, de-duplicated by id and sorted DESC (newest first)
        setLocations((prev) => {
          const base: Location[] = reset ? [] : prev;
          const byId: Record<string, Location> = {};

          for (const loc of base) {
            byId[loc.id] = loc;
          }
          for (const loc of pageRemoteDesc as Location[]) {
            if (loc && loc.id) {
              byId[loc.id] = loc as Location;
            }
          }
          for (const loc of pendingAsLocations) {
            byId[loc.id] = loc;
          }

          const mergedArray = Object.values(byId).sort(
            (a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );

          console.log("[Location:page] fetchLocations 3. Merged page", {
            remotePageCount: pageRemoteDesc.length,
            pendingCount: pendingList.length,
            mergedCount: mergedArray.length,
            hasMore,
          });

          return mergedArray;
        });
      } catch (error) {
        console.error("[Location:page] fetchLocations Error:", error);
      } finally {
        if (!reset) {
          isLoadingMoreRef.current = false;
          setLocationsLoadingMore(false);
        }
      }
    },
    [user, db]
  );

  const fetchFriendLocations = useCallback(async () => {
    if (!user || !db) {
      setFriendLocations([]);
      return;
    }

    try {
      // Get friendships where current user is the friend and sharing is enabled
      const friendshipsSnapshot = await getDocs(
        query(
          collection(db, "friendships"),
          where("friend_id", "==", user.uid),
          where("share_location_with_friend", "==", true)
        )
      );

      // Get latest location for each friend
      const friendLocationsPromises = friendshipsSnapshot.docs.map(async (friendshipDoc) => {
        const friendshipData = friendshipDoc.data();
        const friendUserId = friendshipData.user_id;
        
        // Get latest location for this friend
        const locationsSnapshot = await getDocs(
          query(
            collection(db, "locations"),
            where("user_id", "==", friendUserId),
            orderBy("timestamp", "desc"),
            limit(1)
          )
        );

        if (locationsSnapshot.empty) return null;

        const locationDoc = locationsSnapshot.docs[0];
        const locationData = locationDoc.data();
        
        return {
          friend_id: friendUserId,
          friend_email: friendshipData.friend_email,
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          timestamp: locationData.timestamp instanceof Timestamp 
            ? locationData.timestamp.toDate().toISOString() 
            : locationData.timestamp,
        };
      });

      const results = await Promise.all(friendLocationsPromises);
      const rows = results.filter((r): r is FriendLocation => r !== null);
      setFriendLocations(rows);
    } catch (e) {
      console.warn("[Friends] fetchFriendLocations failed", e);
    }
  }, [user, db]);

  // Sync pending locations to Firestore (upload then remove from local).
  // Battery-friendly: one batched HTTP insert per run, at most every 5 minutes via the interval below.
  const syncPendingLocationsToFirestore = useCallback(async () => {
    if (!user || !db) return;
    try {
      const pending = await getPendingLocationsForUser(user.uid);
      if (pending.length === 0) return;

      const now = Date.now();
      const rows = pending.map((loc) => {
        const storedWait = loc.wait_time ?? 0;
        const elapsedSinceUpdate = Math.max(
          0,
          Math.floor((now - new Date(loc.timestamp).getTime()) / 1000)
        );
        const effectiveWaitTime = storedWait + elapsedSinceUpdate;
        return {
          user_id: loc.user_id,
          latitude: loc.latitude,
          longitude: loc.longitude,
          timestamp: Timestamp.fromDate(new Date(loc.timestamp)),
          wait_time: effectiveWaitTime,
          created_at: Timestamp.now(),
        };
      });

      // Insert all locations in parallel
      await Promise.all(rows.map((row) => addDoc(collection(db, "locations"), row)));
      
      for (const loc of pending) {
        await deletePendingLocation(loc.id);
      }
      // Clear any stale snapshot that might still be in native Preferences so the
      // background runner doesn't re-upload already-synced locations.
      if (isNativePlatform()) {
        try {
          await Preferences.remove({ key: "jeethtravel.pending" });
        } catch {
          // Best-effort; safe to ignore if this fails.
        }
      }
      
      // After syncing, refetch from the first page so the on-screen history/map stay up to date
      fetchLocations({ reset: true });
    } catch (e) {
      console.warn("[Location:sync] Background sync failed", e);
    }
  }, [user, db, fetchLocations]);

  // While the app is in the foreground, upload pending locations as often as every 30 seconds
  // (single batched HTTP call per run). Background uploads are still throttled separately
  // inside the native background runner.
  useEffect(() => {
    if (!user || !db) return;
    const intervalMs = 30 * 1000;
    const id = setInterval(syncPendingLocationsToFirestore, intervalMs);
    return () => clearInterval(id);
  }, [user, db, syncPendingLocationsToFirestore]);

  // Sync pending + auth to Preferences so Background Runner can upload when OS runs the task (iOS/Android).
  // Must run while app is in foreground: when we only sync on background, iOS often suspends before the
  // async write completes, so the runner finds nothing. We sync proactively so data is there when the runner runs.
  const syncPendingToPreferencesForRunner = useCallback(async () => {
    if (!isNativePlatform() || !user || !auth) return;
    try {
      // First, apply any uploadedIds recorded by the background runner so we don't
      // keep re-writing already-uploaded locations back into Preferences/IndexedDB.
      try {
        const { value: uploadedRaw } = await Preferences.get({
          key: "jeethtravel.uploadedIds",
        });
        if (uploadedRaw) {
          const uploadedIds = JSON.parse(uploadedRaw) as string[];
          if (Array.isArray(uploadedIds) && uploadedIds.length > 0) {
            console.log("[Location:Preferences] pruning uploadedIds before snapshot", {
              count: uploadedIds.length,
            });
            for (const id of uploadedIds) {
              await deletePendingLocation(id);
            }
          }
          await Preferences.remove({ key: "jeethtravel.uploadedIds" });
        }
      } catch (e) {
        console.warn("[Location:Preferences] failed to prune uploadedIds before snapshot", e);
      }

      const pending = await getPendingLocationsForUser(user.uid);
      const token = await auth.currentUser?.getIdToken();
      if (pending.length > 0 && token) {
        await Preferences.set({
          key: "jeethtravel.pending",
          value: JSON.stringify(pending),
        });
        await Preferences.set({
          key: "jeethtravel.firebaseAuth",
          value: JSON.stringify({
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
            apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
            accessToken: token,
          }),
        });
        console.log("[Location:Preferences] synced pending to Preferences for runner", { count: pending.length });
      }
    } catch (e) {
      console.warn("[Location:Preferences] sync for runner failed", e);
    }
  }, [user, auth]);

  // Proactive sync: we only write to Preferences when pending locations change or on app
  // background/foreground transitions. No periodic timer to minimize background work.

  // Periodically refresh friends' latest locations so the map stays up to date
  useEffect(() => {
    if (!user || !db) return;
    fetchFriendLocations();
    const intervalMs = 30 * 1000;
    const id = setInterval(fetchFriendLocations, intervalMs);
    return () => clearInterval(id);
  }, [user, db, fetchFriendLocations]);

  // On app background: one more sync (best effort). On app active: apply uploadedIds from runner.
  useEffect(() => {
    if (!isNativePlatform()) return;
    const listenerPromise = App.addListener("appStateChange", async (state) => {
      if (state.isActive) {
        try {
          const { value } = await Preferences.get({ key: "jeethtravel.uploadedIds" });
          if (value) {
            const ids = JSON.parse(value) as string[];
            console.log("[Location:uploadedIds] applying from runner", { count: ids.length });
            for (const id of ids) await deletePendingLocation(id);
            await Preferences.remove({ key: "jeethtravel.uploadedIds" });
            fetchLocations({ reset: true });
          }
        } catch (e) {
          console.warn("[Location:uploadedIds] apply failed", e);
        }
      } else {
        console.log("[Location:Preferences] app backgrounded, syncing pending for runner");
        await syncPendingToPreferencesForRunner();
      }
    });
    return () => { listenerPromise.then((l) => l.remove()).catch(() => {}); };
  }, [syncPendingToPreferencesForRunner, fetchLocations]);

  const RUNNER_LABEL = "com.jeethtravel.app.uploadLocations";
  const testBackgroundUpload = useCallback(async () => {
    if (!isNativePlatform() || !user) return;
    try {
      console.log("[Location:test] Syncing pending to Preferences, then dispatching runner…");
      await syncPendingToPreferencesForRunner();
      await BackgroundRunner.dispatchEvent({
        label: RUNNER_LABEL,
        event: "uploadPendingLocations",
        details: {},
      });
      console.log("[Location:test] Runner finished");
      fetchLocations({ reset: true });
    } catch (e) {
      console.error("[Location:test] Runner failed", e);
    }
  }, [user, syncPendingToPreferencesForRunner, fetchLocations]);

  const fetchPhotos = useCallback(async () => {
    if (!user) {
      setPhotos([]);
      return;
    }

    try {
      const [localRecords, pendingList, firestorePhotos] = await Promise.all([
        getAllLocalPhotosForUser(user.uid),
        getPendingPhotosForUser(user.uid),
        db ? getPhotoMetadataForUser(db, user.uid) : Promise.resolve([]),
      ]);

      pendingPhotoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingPhotoUrlsRef.current.clear();

      const localWithUrls: PhotoWithLocation[] = await Promise.all(
        localRecords
          .filter((r) => r.latitude != null && r.longitude != null)
          .map(async (rec) => {
            const url = await getLocalPhotoUrl(rec);
            pendingPhotoUrlsRef.current.set(rec.id, url);
            return {
              id: rec.id,
              latitude: rec.latitude!,
              longitude: rec.longitude!,
              timestamp: rec.timestamp,
              storage_path: "",
              url,
            };
          })
      );

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

      const localAndPendingIds = new Set([
        ...localWithUrls.map((p) => p.id),
        ...pendingPhotos.map((p) => p.id),
      ]);
      const firestoreOnlyWithLocation: PhotoWithLocation[] = firestorePhotos
        .filter(
          (m) =>
            !localAndPendingIds.has(m.id) &&
            m.latitude != null &&
            m.longitude != null
        )
        .map((m) => ({
          id: m.id,
          latitude: m.latitude!,
          longitude: m.longitude!,
          timestamp: m.timestamp,
          storage_path: "",
          url: undefined,
        }));

      const merged = [
        ...pendingPhotos,
        ...localWithUrls,
        ...firestoreOnlyWithLocation,
      ].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setPhotos(merged);
    } catch (error) {
      console.error("Error fetching photos:", error);
    }
  }, [user, db]);

  // Keep locationsRef in sync with locations state
  useEffect(() => {
    locationsRef.current = locations;
  }, [locations]);

  // Persist locations to localStorage whenever they change so they survive reload
  useEffect(() => {
    if (user && locations.length > 0) {
      persistLocations(user.uid, locations);
    }
  }, [user, locations, persistLocations]);

  useEffect(() => {
    if (user) {
      // Restore from cache immediately so the map/history aren't empty on reload
      const cached = restoreLocationsFromCache(user.uid);
      if (cached.length > 0) {
        setLocations(cached);
      }
      fetchLocations({ reset: true });
      fetchPhotos();
      fetchFriendLocations();
    } else {
      setLocations([]);
      setPhotos([]);
    }
  }, [user, fetchLocations, fetchPhotos, fetchFriendLocations, restoreLocationsFromCache]);

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

        <Friends
          user={user}
          onSharingChange={fetchFriendLocations}
          friendsSharing={friendLocations}
          onFriendFocus={(location) => setFocusLocation(location)}
        />

        {user && (
          <>
            {isNativePlatform() && (
              <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <button
                  type="button"
                  onClick={testBackgroundUpload}
                  className="text-sm px-3 py-1.5 rounded bg-amber-500 text-white hover:bg-amber-600"
                >
                  Test background upload
                </button>
                <p className="text-xs text-amber-800 dark:text-amber-200 mt-2">
                  Runs the same code iOS runs in background (check Xcode/console for [BackgroundAppRefresh] logs). Real background uploads run only on a physical device, usually 5–15+ minutes after you leave the app; iOS decides when. Enable Settings → General → Background App Refresh for this app.
                </p>
              </div>
            )}
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
                    friendLocations={friendLocations}
                    onLocationUpdate={fetchLocations}
                    focusLocation={focusLocation}
                    onPendingLocationsChange={isNativePlatform() ? syncPendingToPreferencesForRunner : undefined}
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
                    onRefresh={() => fetchLocations({ reset: true })}
                    hasMore={locationsHasMore}
                    isLoadingMore={locationsLoadingMore}
                    onLoadMore={() => fetchLocations({ reset: false })}
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

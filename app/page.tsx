"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { collection, query, where, orderBy, limit, startAfter, getDocs, Timestamp, type DocumentSnapshot } from "firebase/firestore";
import dynamicImport from "next/dynamic";
import Auth from "@/components/Auth";
import FriendsPanel from "@/components/FriendsPanel";
import LocationHistory from "@/components/LocationHistory";
import PhotoGallery from "@/components/PhotoGallery";
import UserProfilePanel from "@/components/UserProfilePanel";
import TripsPanel from "@/components/TripsPanel";
import TripDetailView from "@/components/TripDetailView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { User } from "@/lib/types";
import { getFirebaseAuth, getFirebaseFirestore } from "@/lib/firebase";
import { getPendingLocationsForUser, getPendingPhotosForUser, deletePendingLocation } from "@/lib/localStore";
import { subscribeUserSettings } from "@/lib/userSettings";
import { subscribeSharedLocationsForUser } from "@/lib/sharedLocations";
import { updateMySharedLocation } from "@/lib/sharedLocations";
import { subscribeTrips, getActiveTrips, type Trip } from "@/lib/firebase/trips";
import { isNativePlatform } from "@/lib/capacitor";
import { Preferences } from "@capacitor/preferences";
import { App } from "@capacitor/app";
import type { MapHandle } from "@/components/Map";

// Dynamically import Map component to prevent SSR issues with Leaflet
const Map = dynamicImport(() => import("@/components/Map"), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full bg-background">Loading map...</div>,
});

interface Location {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time?: number;
  trip_ids?: string[];
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
  const LOCATIONS_PAGE_SIZE = 50;
  const componentMountTime = useRef(Date.now());

  const [user, setUser] = useState<User | null>(null);
  const [remoteLocations, setRemoteLocations] = useState<Location[]>([]);
  const [lastVisible, setLastVisible] = useState<DocumentSnapshot | null>(null);
  const [hasMoreLocations, setHasMoreLocations] = useState(false);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [pendingLocations, setPendingLocations] = useState<Location[]>([]);
  const [photos, setPhotos] = useState<PhotoWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusLocation, setFocusLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const pendingPhotoUrlsRef = useRef<globalThis.Map<string, string>>(new globalThis.Map());
  const mapRef = useRef<MapHandle | null>(null);

  // Merged list: remote (newest first) + pending, sorted reverse-chronological. Map needs chronological so we derive that for Map only.
  const locations = useMemo(() => {
    const merged = [...remoteLocations, ...pendingLocations].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return merged;
  }, [remoteLocations, pendingLocations]);

  const locationsChronological = useMemo(
    () => [...locations].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [locations]
  );

  // Tracking state from Map (for overlay buttons and Location History panel)
  const [trackingState, setTrackingState] = useState<{
    isTracking: boolean;
    isRequesting: boolean;
    error: string | null;
    permissionStatus: PermissionState | null;
    currentLocation: { lat: number; lng: number } | null;
  }>({ isTracking: false, isRequesting: false, error: null, permissionStatus: null, currentLocation: null });

  // Overlay panel state
  const [locationHistoryOpen, setLocationHistoryOpen] = useState(false);
  const [photosPanelOpen, setPhotosPanelOpen] = useState(false);
  const [friendsPanelOpen, setFriendsPanelOpen] = useState(false);
  const [tripsPanelOpen, setTripsPanelOpen] = useState(false);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [activeTrips, setActiveTrips] = useState<Trip[]>([]);
  const [userDisplayName, setUserDisplayName] = useState("");
  const [friendLocations, setFriendLocations] = useState<Array<{ user_id: string; display_name: string; lat: number; lng: number; timestamp: string; wait_time?: number }>>([]);
  const lastSharedLocationTimestampRef = useRef<string | null>(null);

  // Firebase auth state: require login
  useEffect(() => {
    const effectStartTime = Date.now();
    console.log("[App] Initializing Firebase auth...");
    console.log("[App] Environment check:", {
      hasApiKey: !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      hasProjectId: !!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      hasAuthDomain: !!process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      isNative: isNativePlatform(),
      windowDefined: typeof window !== "undefined",
    });

    const auth = getFirebaseAuth();
    const authElapsed = Date.now() - effectStartTime;
    console.log(`[App] getFirebaseAuth() returned in ${authElapsed}ms:`, auth ? "Auth instance" : "null");
    
    if (!auth) {
      console.warn("[App] Firebase auth not available, setting loading to false");
      setLoading(false);
      return;
    }

    console.log("[App] Setting up onAuthStateChanged listener...");
    let authStateResolved = false;
    const listenerStartTime = Date.now();
    
    const unsub = onAuthStateChanged(
      auth,
      (firebaseUser) => {
        const listenerElapsed = Date.now() - listenerStartTime;
        console.log(`[App] Auth state changed after ${listenerElapsed}ms:`, {
          hasUser: !!firebaseUser,
          uid: firebaseUser?.uid,
          email: firebaseUser?.email,
        });
        
        authStateResolved = true;
        if (firebaseUser) {
          setUser({
            id: firebaseUser.uid,
            email: firebaseUser.email ?? null,
          });
        } else {
          setUser(null);
        }
        setLoading(false);
        console.log("[App] Loading set to false after auth state change");
      },
      (error) => {
        const listenerElapsed = Date.now() - listenerStartTime;
        console.error(`[App] Auth state change error after ${listenerElapsed}ms:`, error);
        authStateResolved = true;
        setLoading(false);
      }
    );

    // Fallback timeout: if auth state doesn't resolve within 5 seconds, stop loading
    const timeoutId = setTimeout(() => {
      if (!authStateResolved) {
        const elapsed = Date.now() - listenerStartTime;
        console.warn(`[App] Auth state change timeout after ${elapsed}ms - forcing loading to false`);
        setLoading(false);
      }
    }, 5000);

    return () => {
      console.log("[App] Cleaning up auth listener");
      clearTimeout(timeoutId);
      unsub();
    };
  }, []);

  const handleSignOut = useCallback(() => {
    setUser(null);
  }, []);

  const fetchLocations = useCallback(async () => {
    if (!user) {
      setRemoteLocations([]);
      setPendingLocations([]);
      setLastVisible(null);
      setHasMoreLocations(false);
      return;
    }
    setLoadingLocations(true);
    try {
      const db = getFirebaseFirestore();
      const [firestoreSnap, pendingList] = await Promise.all([
        db
          ? (() => {
              const q = query(
                collection(db, "locations"),
                where("user_id", "==", user.id),
                orderBy("timestamp", "desc"),
                limit(LOCATIONS_PAGE_SIZE)
              );
              return getDocs(q);
            })()
          : Promise.resolve(null),
        getPendingLocationsForUser(user.id),
      ]);

      const remote: Location[] = [];
      let newLastVisible: DocumentSnapshot | null = null;
      if (firestoreSnap && !firestoreSnap.empty) {
        firestoreSnap.docs.forEach((doc) => {
          const d = doc.data();
          remote.push({
            id: doc.id,
            latitude: d.latitude ?? 0,
            longitude: d.longitude ?? 0,
            timestamp: d.timestamp instanceof Timestamp
              ? d.timestamp.toDate().toISOString()
              : String(d.timestamp ?? ""),
            wait_time: d.wait_time,
            trip_ids: d.trip_ids,
          });
        });
        newLastVisible = firestoreSnap.docs[firestoreSnap.docs.length - 1];
      }
      setRemoteLocations(remote);
      setLastVisible(newLastVisible);
      setHasMoreLocations(firestoreSnap ? firestoreSnap.docs.length === LOCATIONS_PAGE_SIZE : false);

      const pendingAsLocations: Location[] = pendingList.map((p) => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: p.timestamp,
        wait_time: p.wait_time,
        trip_ids: p.trip_ids,
      }));
      setPendingLocations(pendingAsLocations);
    } catch (error) {
      console.error("[Location:page] fetchLocations Error:", error);
    } finally {
      setLoadingLocations(false);
    }
  }, [user]);

  const loadMoreLocations = useCallback(async () => {
    if (!user || !lastVisible || !hasMoreLocations) return;
    const db = getFirebaseFirestore();
    if (!db) return;
    setLoadingLocations(true);
    try {
      const q = query(
        collection(db, "locations"),
        where("user_id", "==", user.id),
        orderBy("timestamp", "desc"),
        limit(LOCATIONS_PAGE_SIZE),
        startAfter(lastVisible)
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        setHasMoreLocations(false);
        return;
      }
      const next: Location[] = [];
      snap.docs.forEach((doc) => {
        const d = doc.data();
        next.push({
          id: doc.id,
          latitude: d.latitude ?? 0,
          longitude: d.longitude ?? 0,
          timestamp: d.timestamp instanceof Timestamp
            ? d.timestamp.toDate().toISOString()
            : String(d.timestamp ?? ""),
          wait_time: d.wait_time,
          trip_ids: d.trip_ids,
        });
      });
      setRemoteLocations((prev) => [...prev, ...next]);
      setLastVisible(snap.docs[snap.docs.length - 1]);
      setHasMoreLocations(snap.docs.length === LOCATIONS_PAGE_SIZE);
    } catch (error) {
      console.error("[Location:page] loadMoreLocations Error:", error);
    } finally {
      setLoadingLocations(false);
    }
  }, [user, lastVisible, hasMoreLocations]);

  const fetchPhotos = useCallback(async () => {
    if (!user) {
      setPhotos([]);
      return;
    }
    try {
      const pendingList = await getPendingPhotosForUser(user.id);
      pendingPhotoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingPhotoUrlsRef.current.clear();
      const withLocation: PhotoWithLocation[] = pendingList
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
      withLocation.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setPhotos(withLocation);
    } catch (error) {
      console.error("Error fetching photos:", error);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      fetchLocations();
      fetchPhotos();
    } else {
      setRemoteLocations([]);
      setPendingLocations([]);
      setLastVisible(null);
      setHasMoreLocations(false);
      setPhotos([]);
    }
  }, [user, fetchLocations, fetchPhotos]);

  // Sync pending locations + Firebase auth to Preferences so background runner can upload to Firestore
  const syncPendingToPreferencesForRunner = useCallback(async () => {
    if (!isNativePlatform() || !user) return;
    const auth = getFirebaseAuth();
    if (!auth?.currentUser) return;
    try {
      const pending = await getPendingLocationsForUser(user.id);
      if (pending.length === 0) return;
      const token = await auth.currentUser.getIdToken(true);
      const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
      if (!projectId) return;
      await Preferences.set({
        key: "jeethtravel.pending",
        value: JSON.stringify(pending),
      });
      await Preferences.set({
        key: "jeethtravel.firebaseAuth",
        value: JSON.stringify({ projectId, idToken: token }),
      });
    } catch (e) {
      console.warn("[Location:Preferences] sync for runner failed", e);
    }
  }, [user]);

  useEffect(() => {
    if (!isNativePlatform() || !user) return;
    const intervalMs = 15 * 1000;
    const id = setInterval(syncPendingToPreferencesForRunner, intervalMs);
    syncPendingToPreferencesForRunner();
    return () => clearInterval(id);
  }, [user, syncPendingToPreferencesForRunner]);

  useEffect(() => {
    if (!user?.id) return;
    const unsub = subscribeUserSettings(user.id, (s) => setUserDisplayName(s.displayName ?? ""));
    return () => unsub();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const unsub = subscribeSharedLocationsForUser(user.id, setFriendLocations);
    return () => unsub();
  }, [user?.id]);

  // Subscribe to trips and update active trips
  useEffect(() => {
    if (!user?.id) {
      setActiveTrips([]);
      return;
    }
    try {
      const unsubscribe = subscribeTrips(user.id, async (trips) => {
        try {
          const active = await getActiveTrips(user.id);
          setActiveTrips(active);
        } catch (error) {
          console.error("[App] Error getting active trips:", error);
          setActiveTrips([]);
        }
      });
      return () => unsubscribe();
    } catch (error) {
      console.error("[App] Error subscribing to trips:", error);
      setActiveTrips([]);
      return () => {};
    }
  }, [user?.id]);

  const handleLocationSaved = useCallback(
    async (lat: number, lng: number, timestamp: string, waitTime?: number) => {
      if (!user?.id) return;
      await updateMySharedLocation(user.id, userDisplayName, lat, lng, timestamp, waitTime);
    },
    [user?.id, userDisplayName]
  );

  // When we have locations and share with friends, keep shared_locations in sync (e.g. after toggle or load)
  useEffect(() => {
    if (!user?.id || locations.length === 0) {
      lastSharedLocationTimestampRef.current = null;
      return;
    }
    const latest = locations[0];
    // Only update if the timestamp actually changed to prevent infinite loops
    if (lastSharedLocationTimestampRef.current === latest.timestamp) {
      return;
    }
    lastSharedLocationTimestampRef.current = latest.timestamp;
    updateMySharedLocation(
      user.id,
      userDisplayName,
      latest.latitude,
      latest.longitude,
      latest.timestamp,
      latest.wait_time
    ).catch(() => {
      // Reset ref on error so we can retry
      lastSharedLocationTimestampRef.current = null;
    });
  }, [user?.id, userDisplayName, locations.length, locations[0]?.timestamp]);

  // On app active: apply uploadedIds from runner (remove from IndexedDB and refetch)
  useEffect(() => {
    if (!isNativePlatform()) {
      return;
    }
    
    const listenerPromise = App.addListener("appStateChange", async (state) => {
      if (state.isActive) {
        try {
          // Handle location uploads from background runner
          const { value } = await Preferences.get({ key: "jeethtravel.uploadedIds" });
          if (value) {
            const ids = JSON.parse(value) as string[];
            for (const id of ids) await deletePendingLocation(id);
            await Preferences.remove({ key: "jeethtravel.uploadedIds" });
            fetchLocations();
          }
        } catch (e) {
          console.warn("[Location:uploadedIds] apply failed", e);
        }
      } else {
        syncPendingToPreferencesForRunner();
      }
    });
    return () => {
      listenerPromise.then((l) => l.remove()).catch(() => {});
    };
  }, [syncPendingToPreferencesForRunner, fetchLocations]);

  useEffect(() => {
    return () => {
      pendingPhotoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingPhotoUrlsRef.current.clear();
    };
  }, []);

  // Log startup summary when component finishes initializing (only once)
  useEffect(() => {
    if (loading) return; // Wait until loading is complete
    const totalTime = Date.now() - componentMountTime.current;
    console.log(`[STARTUP:SUMMARY] Component initialization completed in ${totalTime}ms`);
    console.log("[STARTUP:SUMMARY] Current state:", {
      hasUser: !!user,
      userId: user?.id,
      locationCount: locations.length,
      photoCount: photos.length,
      isNative: isNativePlatform(),
    });
  }, [loading]); // Only depend on loading to log once when it becomes false

  if (loading) {
    const elapsed = Date.now() - componentMountTime.current;
    console.log(`[RENDER:${elapsed}ms] Rendering loading screen`, {
      hasUser: !!user,
      isNative: isNativePlatform(),
    });
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-muted-foreground">Loading...</p>
          {isNativePlatform() && (
            <p className="text-xs text-muted-foreground mt-2">
              Initializing Firebase...
            </p>
          )}
        </div>
      </div>
    );
  }

  const renderElapsed = Date.now() - componentMountTime.current;
  console.log(`[RENDER:${renderElapsed}ms] Rendering main app`, {
    hasUser: !!user,
    loading,
    locationCount: locations.length,
    photoCount: photos.length,
  });

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Full-screen map */}
      <div className="absolute inset-0 z-0">
        <Map
          ref={mapRef}
          user={user}
          locations={locationsChronological.map((loc: Location) => ({
            lat: loc.latitude,
            lng: loc.longitude,
            timestamp: loc.timestamp,
            wait_time: loc.wait_time,
            trip_ids: loc.trip_ids,
          }))}
          photos={photos}
          friendLocations={friendLocations}
          trips={activeTrips}
          onLocationUpdate={fetchLocations}
          focusLocation={focusLocation}
          onPendingLocationsChange={isNativePlatform() ? syncPendingToPreferencesForRunner : undefined}
          onTrackingChange={setTrackingState}
          onLocationSaved={handleLocationSaved}
        />
      </div>


      {/* Top-left: map title + navigation (only when signed in) */}
      {user && (
        <div className="absolute top-0 left-0 z-10 p-3 safe-area-top-left">
          <Card className="border-border/80 bg-card/95 shadow-lg backdrop-blur-sm">
            <CardHeader className="pb-2 pt-3 px-3">
              <CardTitle className="text-base font-semibold">Map</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-1 pt-0 px-3 pb-3">
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={() => mapRef.current?.zoomIn?.()}
                  aria-label="Zoom in"
                >
                  <span className="text-lg font-semibold leading-none">+</span>
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={() => mapRef.current?.zoomOut?.()}
                  aria-label="Zoom out"
                >
                  <span className="text-lg font-semibold leading-none">−</span>
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={() => mapRef.current?.flyToCurrentLocation?.()}
                  aria-label="My location"
                >
                  <span className="text-sm">⌖</span>
                </Button>
              </div>
              <Button
                variant={trackingState.isTracking ? "destructive" : "secondary"}
                size="icon"
                onClick={() => mapRef.current?.toggleTracking?.()}
                disabled={trackingState.isRequesting}
                className={
                  !trackingState.isTracking && !trackingState.isRequesting
                    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                    : ""
                }
                aria-label={trackingState.isRequesting ? "Requesting" : trackingState.isTracking ? "Stop tracking" : "Start tracking"}
                title={trackingState.isRequesting ? "Requesting…" : trackingState.isTracking ? "Stop tracking" : "Start tracking"}
              >
                <span className="text-xs">{trackingState.isRequesting ? "…" : trackingState.isTracking ? "⏹" : "▶"}</span>
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Top-right: Profile button (when signed in) */}
      {user && (
        <div className="absolute top-0 right-0 z-10 p-3 safe-area-top-right">
          <Button
            variant="secondary"
            className="bg-card/95 shadow-lg backdrop-blur-sm border-border/80"
            onClick={() => setProfilePanelOpen(true)}
          >
            Profile
          </Button>
        </div>
      )}

      {/* User Profile panel (Sheet from right) */}
      {user && (
        <UserProfilePanel
          user={user}
          open={profilePanelOpen}
          onOpenChange={setProfilePanelOpen}
          onSignOut={handleSignOut}
        />
      )}

      {/* Bottom bar: Active trips + Location History */}
      {user && (
        <div className="absolute bottom-0 left-0 right-0 z-10 flex flex-col gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
          {activeTrips.length > 0 && (
            <div className="flex justify-center">
              <Card className="border-border/80 bg-card/95 shadow-lg backdrop-blur-sm">
                <CardContent className="pt-3 px-4 pb-3">
                  <div className="flex items-center gap-2 flex-wrap justify-center">
                    <span className="text-xs text-muted-foreground">Active trips:</span>
                    {activeTrips.map((trip) => (
                      <span key={trip.id} className="text-xs font-medium px-2 py-1 bg-primary/10 text-primary rounded">
                        {trip.name}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          <div className="flex justify-center">
            <Button
              variant="secondary"
              className="bg-card/95 shadow-lg backdrop-blur-sm border-border/80"
              onClick={() => setLocationHistoryOpen(true)}
            >
              Location history
            </Button>
          </div>
        </div>
      )}

      {/* Right side: Photos + Friends + Trips buttons */}
      {user && (
        <div className="absolute top-1/2 right-0 z-10 flex flex-col gap-2 -translate-y-1/2 p-2 pr-[max(0.5rem,env(safe-area-inset-right))]">
          <Button
            variant="secondary"
            className="flex flex-col items-center gap-1 rounded-l-xl rounded-r-md bg-card/95 py-3 px-2 shadow-lg backdrop-blur-sm border border-r-0 border-border h-auto"
            onClick={() => { setPhotosPanelOpen(true); setFriendsPanelOpen(false); setTripsPanelOpen(false); }}
            title="Photos"
          >
            <span className="text-xl">📷</span>
            <span className="text-xs font-medium">Photos</span>
          </Button>
          <Button
            variant="secondary"
            className="flex flex-col items-center gap-1 rounded-l-xl rounded-r-md bg-card/95 py-3 px-2 shadow-lg backdrop-blur-sm border border-r-0 border-border h-auto"
            onClick={() => { setFriendsPanelOpen(true); setPhotosPanelOpen(false); setTripsPanelOpen(false); }}
            title="Friends"
          >
            <span className="text-xl">👥</span>
            <span className="text-xs font-medium">Friends</span>
          </Button>
          <Button
            variant="secondary"
            className="flex flex-col items-center gap-1 rounded-l-xl rounded-r-md bg-card/95 py-3 px-2 shadow-lg backdrop-blur-sm border border-r-0 border-border h-auto"
            onClick={() => { setTripsPanelOpen(true); setPhotosPanelOpen(false); setFriendsPanelOpen(false); }}
            title="Trips"
          >
            <span className="text-xl">✈️</span>
            <span className="text-xs font-medium">Trips</span>
          </Button>
        </div>
      )}

      {/* Location History panel (Sheet from bottom) */}
      {user && (
        <Sheet open={locationHistoryOpen} onOpenChange={setLocationHistoryOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[85vh] flex flex-col"
            onOpenChange={setLocationHistoryOpen}
          >
            <SheetHeader className="pt-12 pr-12">
              <SheetTitle>Location history</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 overflow-hidden flex flex-col flex-1 min-h-0">
              <Card>
                <CardContent className="pt-4 space-y-2">
                  <Button
                    className="w-full"
                    variant={trackingState.isTracking ? "destructive" : "default"}
                    disabled={trackingState.isRequesting}
                    onClick={() => mapRef.current?.toggleTracking?.()}
                  >
                    {trackingState.isRequesting ? "Requesting…" : trackingState.isTracking ? "Stop tracking" : "Start tracking"}
                  </Button>
                  {trackingState.permissionStatus === "denied" && !trackingState.error && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">Location permission denied. Enable in settings to track.</p>
                  )}
                  {trackingState.error && (
                    <p className="text-xs text-red-600 dark:text-red-400">{trackingState.error}</p>
                  )}
                  {trackingState.currentLocation && trackingState.isTracking && (
                    <p className="text-xs font-mono text-muted-foreground">
                      Current: {trackingState.currentLocation.lat.toFixed(5)}, {trackingState.currentLocation.lng.toFixed(5)}
                    </p>
                  )}
                </CardContent>
              </Card>
              <div className="flex-1 overflow-y-auto min-h-0">
                <LocationHistory
                  user={user}
                  locations={locations}
                  hasMore={hasMoreLocations}
                  loadingMore={loadingLocations}
                  onLoadMore={loadMoreLocations}
                  onLocationSelect={(location) => {
                    setFocusLocation({ latitude: location.latitude, longitude: location.longitude });
                    setLocationHistoryOpen(false);
                  }}
                  onRefresh={fetchLocations}
                />
              </div>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Photos panel (Sheet from right) */}
      {user && (
        <Sheet open={photosPanelOpen} onOpenChange={setPhotosPanelOpen}>
          <SheetContent side="right" className="w-full max-w-md flex flex-col p-0" onOpenChange={setPhotosPanelOpen}>
            <SheetHeader className="p-4 pt-12 pr-12 border-b border-border">
              <SheetTitle>Photos</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto">
              <PhotoGallery
                user={user}
                onPhotoClick={(photo) => {
                  if (photo.latitude && photo.longitude) {
                    setFocusLocation({ latitude: photo.latitude, longitude: photo.longitude });
                    setPhotosPanelOpen(false);
                  }
                }}
                onPhotosUpdate={fetchPhotos}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Friends panel (Sheet from right) */}
      {user && (
        <Sheet open={friendsPanelOpen} onOpenChange={setFriendsPanelOpen}>
          <SheetContent side="right" className="w-full max-w-md flex flex-col p-0" onOpenChange={setFriendsPanelOpen}>
            <SheetHeader className="p-4 pt-12 pr-12 border-b border-border">
              <SheetTitle>Friends</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-4">
              <FriendsPanel
                user={user}
                userDisplayName={userDisplayName}
                open={friendsPanelOpen}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Trips panel (Sheet from right) */}
      {user && (
        <Sheet open={tripsPanelOpen} onOpenChange={setTripsPanelOpen}>
          <SheetContent side="right" className="w-full max-w-md flex flex-col p-0" onOpenChange={setTripsPanelOpen}>
            <SheetHeader className="p-4 pt-12 pr-12 border-b border-border">
              <SheetTitle>Trips</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-4">
              {selectedTrip ? (
                <TripDetailView
                  user={user}
                  trip={selectedTrip}
                  onClose={() => setSelectedTrip(null)}
                  onTripDeleted={() => {
                    setSelectedTrip(null);
                    getActiveTrips(user.id).then(setActiveTrips);
                  }}
                  onTripUpdated={() => {
                    getActiveTrips(user.id).then(setActiveTrips);
                  }}
                />
              ) : (
                <TripsPanel
                  user={user}
                  open={tripsPanelOpen}
                  onTripSelect={(trip) => setSelectedTrip(trip)}
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Signed-out message over map */}
      {!user && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
          <div className="rounded-2xl bg-card/95 shadow-xl backdrop-blur-sm p-6 max-w-sm text-center border border-border">
            <Auth user={user} onSignOut={handleSignOut} />
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { getCachedImage, fetchImageWithCache } from "@/lib/imageCache";
import { isNativePlatform } from "@/lib/capacitor";
import {
  addPendingLocation,
  getPendingLocationsForUser,
  updatePendingLocation,
  deletePendingLocation,
  hashTimelineInput,
  getTimelineCacheSync,
  setTimelineCacheSync,
} from "@/lib/localStore";
import { Geolocation as CapGeolocation } from "@capacitor/geolocation";

// Fix for default marker icons in Next.js - only run on client
if (typeof window !== "undefined") {
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
    iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
    shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  });
}

// Create custom icons for breadcrumbs
const createBreadcrumbIcon = (color: string, size: number = 6) => {
  return L.divIcon({
    className: "breadcrumb-marker",
    html: `<div style="width: ${size}px; height: ${size}px; background-color: ${color}; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 1px rgba(0,0,0,0.2);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const createStartIcon = () => {
  return L.divIcon({
    className: "start-marker",
    html: `<div style="width: 12px; height: 12px; background-color: #10b981; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 2px rgba(16,185,129,0.3);"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
};

const createEndIcon = () => {
  return L.divIcon({
    className: "end-marker",
    html: `<div style="width: 12px; height: 12px; background-color: #ef4444; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 2px rgba(239,68,68,0.3);"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
};

const createPhotoIcon = (isFocused: boolean = false) => {
  const size = isFocused ? 20 : 12;
  const borderWidth = isFocused ? 3 : 2;
  const color = isFocused ? "#f59e0b" : "#8b5cf6";
  const shadowSize = isFocused ? 3 : 1;
  const shadowOpacity = isFocused ? 0.6 : 0.4;
  
  return L.divIcon({
    className: `photo-marker ${isFocused ? "focused" : ""}`,
    html: `<div style="width: ${size}px; height: ${size}px; background-color: ${color}; border-radius: 50%; border: ${borderWidth}px solid white; box-shadow: 0 0 0 ${shadowSize}px rgba(${isFocused ? '245,158,10' : '139,92,246'},${shadowOpacity}); cursor: pointer; pointer-events: auto;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

const createClusterIcon = (count: number) => {
  const size = Math.min(30 + Math.sqrt(count) * 3, 50);
  const fontSize = count > 99 ? 12 : 14;
  
  return L.divIcon({
    className: "cluster-marker-icon",
    html: `<div style="width: ${size}px; height: ${size}px; background-color: #8b5cf6; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 0 2px rgba(139,92,246,0.4); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: ${fontSize}px; cursor: pointer; pointer-events: auto;">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

interface Location {
  lat: number;
  lng: number;
  timestamp: string;
  wait_time?: number;
}

interface Photo {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  storage_path?: string;
  url?: string;
}

interface MapProps {
  user: User | null;
  locations: Location[];
  photos?: Photo[];
  onLocationUpdate: () => void;
  focusLocation?: { latitude: number; longitude: number } | null;
}

// Detect iOS Safari
const isIOSSafari = () => {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const webkit = /WebKit/.test(ua);
  const chrome = /CriOS/.test(ua);
  return iOS && webkit && !chrome;
};

// Check geolocation permission status (web or native)
const checkPermissionStatus = async (): Promise<PermissionState | null> => {
  console.log("[Location:permission] checkPermissionStatus entry", { isNative: isNativePlatform(), hasNavigator: typeof navigator !== "undefined", hasPermissions: typeof navigator !== "undefined" && !!navigator.permissions });
  if (isNativePlatform()) {
    try {
      const status = await CapGeolocation.checkPermissions();
      const loc = status.location;
      console.log("[Location:permission] checkPermissionStatus native result", { loc });
      if (loc === "granted" || loc === "denied" || loc === "prompt") return loc;
      return loc === "prompt-with-rationale" ? "prompt" : null;
    } catch (e) {
      console.log("[Location:permission] checkPermissionStatus native error", e);
      return null;
    }
  }
  if (typeof navigator === "undefined" || !navigator.permissions) {
    console.log("[Location:permission] checkPermissionStatus no navigator.permissions");
    return null;
  }
  try {
    console.log("[Location:permission] querying navigator.permissions for geolocation...");
    const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    console.log("[Location:permission] checkPermissionStatus web result", { state: result.state });
    return result.state;
  } catch (error) {
    console.log("[Location:permission] checkPermissionStatus web error", error);
    return null;
  }
};

// Calculate distance between two coordinates using Haversine formula (returns distance in meters)
const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Proximity threshold in meters (50 meters = ~164 feet)
const PROXIMITY_THRESHOLD = 50;

// Base clustering threshold in degrees
// This will be adjusted based on zoom level
const getClusterThreshold = (zoom: number): number => {
  // At higher zoom levels (zoomed in), use smaller threshold (only cluster exact same location)
  // At lower zoom levels (zoomed out), use larger threshold (cluster nearby photos)
  // Zoom level typically ranges from 1 (world) to 18+ (street level)
  // Thresholds are in degrees - need to be large enough to catch photos at same/similar locations
  // Using a more granular approach with smoother transitions between zoom levels
  
  // Very zoomed in (18+) - only cluster if essentially at the same location
  if (zoom >= 18) {
    return 0.00002; // ~2.2 meters - very tight, only exact same location
  } else if (zoom >= 17) {
    return 0.00005; // ~5.5 meters - very close
  } else if (zoom >= 16) {
    return 0.0001; // ~11 meters - tight clustering
  } else if (zoom >= 15) {
    return 0.00015; // ~16.5 meters - moderate-tight
  } else if (zoom >= 14) {
    return 0.0002; // ~22 meters - moderate clustering
  } else if (zoom >= 13) {
    return 0.0003; // ~33 meters - moderate-loose
  } else if (zoom >= 12) {
    return 0.0004; // ~44 meters - looser clustering
  } else if (zoom >= 11) {
    return 0.0006; // ~66 meters - loose clustering
  } else if (zoom >= 10) {
    return 0.0008; // ~88 meters - loose clustering
  } else if (zoom >= 9) {
    return 0.0012; // ~133 meters - very loose
  } else if (zoom >= 8) {
    return 0.0018; // ~200 meters - very loose clustering
  } else if (zoom >= 7) {
    return 0.0025; // ~277 meters - extremely loose
  } else if (zoom >= 6) {
    return 0.0035; // ~388 meters - extremely loose
  } else if (zoom >= 5) {
    return 0.005; // ~555 meters - very extremely loose
  } else {
    return 0.008; // ~888 meters - maximum clustering distance for very zoomed out
  }
};

function LocationTracker({ user, onLocationUpdate }: { user: User | null; onLocationUpdate: () => void }) {
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<PermissionState | null>(null);
  const watchIdRef = useRef<number | string | null>(null); // number for web, string for Capacitor
  const lastLocationRef = useRef<{
    lat: number;
    lng: number;
    id: string;
    timestamp: string;
    isLocal?: boolean;
    wait_time?: number;
  } | null>(null);
  const lastSaveTimeRef = useRef<number | null>(null);
  const TRACKING_INTERVAL_MS = 5 * 60 * 1000; // Save location at most once every 5 minutes
  const supabase = createClient();

  // Check permission status on mount
  useEffect(() => {
    checkPermissionStatus().then((status) => {
      setPermissionStatus(status);
    });
  }, []);

  // Sync any pending locations into Supabase on mount and when user is available (e.g. after reconnect)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const pending = await getPendingLocationsForUser(user.id);
        if (pending.length === 0 || cancelled) return;
        console.log("[Location:syncPending] Syncing pending locations to Supabase", { count: pending.length });
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (!authUser || authUser.id !== user.id || cancelled) return;
        for (const loc of pending) {
          if (cancelled) return;
          const { data: inserted, error } = await supabase
            .from("locations")
            .insert({
              user_id: loc.user_id,
              latitude: loc.latitude,
              longitude: loc.longitude,
              timestamp: loc.timestamp,
              wait_time: loc.wait_time,
            })
            .select()
            .single();
          if (error) {
            console.warn("[Location:syncPending] Insert failed for", loc.id, error);
            continue;
          }
          await deletePendingLocation(loc.id);
          if (lastLocationRef.current?.id === loc.id && inserted) {
            lastLocationRef.current = {
              lat: inserted.latitude,
              lng: inserted.longitude,
              id: inserted.id,
              timestamp: inserted.timestamp,
              isLocal: false,
            };
          }
          onLocationUpdate();
        }
      } catch (e) {
        console.warn("[Location:syncPending] Error", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, supabase, onLocationUpdate]);

  const saveLocation = useCallback(async (lat: number, lng: number) => {
    console.log("[Location:saveLocation] 1. Entry", { lat, lng, hasUser: !!user });
    if (!user) {
      console.log("[Location:saveLocation] 1b. Early return: no user");
      return;
    }

    try {
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
      console.log("[Location:saveLocation] 2. Auth", { hasAuthUser: !!authUser, authError: authError?.message });
      if (authError || !authUser) {
        setError("Session expired. Please sign in again.");
        return;
      }
      if (authUser.id !== user.id) {
        setError("Session changed. Please refresh the page.");
        return;
      }

      const now = new Date();
      const nowISO = now.toISOString();

      // Check if we have a last location and if it's close enough
      if (lastLocationRef.current) {
        const distance = calculateDistance(
          lastLocationRef.current.lat,
          lastLocationRef.current.lng,
          lat,
          lng
        );
        console.log("[Location:saveLocation] 3. Proximity check", { distance, threshold: PROXIMITY_THRESHOLD, lastId: lastLocationRef.current.id, isLocal: lastLocationRef.current.isLocal });

        if (distance < PROXIMITY_THRESHOLD) {
          const lastTimestamp = new Date(lastLocationRef.current.timestamp);
          const timeDiff = Math.floor((now.getTime() - lastTimestamp.getTime()) / 1000);

          if (lastLocationRef.current.isLocal) {
            console.log("[Location:saveLocation] 4a. Updating pending location locally", { id: lastLocationRef.current.id });
            const currentWait = lastLocationRef.current.wait_time ?? 0;
            const newWaitTime = currentWait + timeDiff;
            await updatePendingLocation(lastLocationRef.current.id, {
              wait_time: newWaitTime,
              timestamp: nowISO,
              latitude: lat,
              longitude: lng,
            });
            lastLocationRef.current = {
              ...lastLocationRef.current,
              lat,
              lng,
              timestamp: nowISO,
              wait_time: newWaitTime,
            };
            console.log("[Location:saveLocation] 4a. Calling onLocationUpdate (after local update)");
            onLocationUpdate();
            return;
          }

          console.log("[Location:saveLocation] 4b. Updating synced location on server", { id: lastLocationRef.current.id });
          const { data: currentLocation, error: fetchError } = await supabase
            .from("locations")
            .select("wait_time")
            .eq("id", lastLocationRef.current.id)
            .single();

          if (fetchError) throw fetchError;

          const newWaitTime = (currentLocation?.wait_time || 0) + timeDiff;

          const { error: updateError } = await supabase
            .from("locations")
            .update({
              wait_time: newWaitTime,
              timestamp: nowISO,
            })
            .eq("id", lastLocationRef.current.id)
            .eq("user_id", authUser.id);

          if (updateError) throw updateError;

          lastLocationRef.current = {
            ...lastLocationRef.current,
            lat,
            lng,
            timestamp: nowISO,
          };

          console.log("[Location:saveLocation] 4b. Calling onLocationUpdate (after server update)");
          onLocationUpdate();
          return;
        }
      }

      console.log("[Location:saveLocation] 5. New location: adding to local store");
      const pending = await addPendingLocation({
        user_id: authUser.id,
        latitude: lat,
        longitude: lng,
        timestamp: nowISO,
        wait_time: 0,
      });
      console.log("[Location:saveLocation] 5. Pending added", { id: pending.id });

      lastLocationRef.current = {
        lat: pending.latitude,
        lng: pending.longitude,
        id: pending.id,
        timestamp: pending.timestamp,
        isLocal: true,
        wait_time: 0,
      };

      console.log("[Location:saveLocation] 6. Calling onLocationUpdate (after new pending)");
      onLocationUpdate();

      // Sync to Supabase in background (non-blocking)
      (async () => {
        try {
          console.log("[Location:saveLocation:bg] 7. Background sync: inserting to Supabase", { pendingId: pending.id });
          const { data: newLocation, error: insertError } = await supabase
            .from("locations")
            .insert({
              user_id: authUser.id,
              latitude: pending.latitude,
              longitude: pending.longitude,
              timestamp: pending.timestamp,
              wait_time: pending.wait_time,
            })
            .select()
            .single();

          if (insertError) {
            console.log("[Location:saveLocation:bg] 7. Insert error", insertError);
            throw insertError;
          }
          console.log("[Location:saveLocation:bg] 7. Insert OK", { serverId: newLocation?.id });

          await deletePendingLocation(pending.id);
          console.log("[Location:saveLocation:bg] 8. Deleted pending from local store");

          if (lastLocationRef.current?.id === pending.id) {
            lastLocationRef.current = {
              lat: newLocation.latitude,
              lng: newLocation.longitude,
              id: newLocation.id,
              timestamp: newLocation.timestamp,
              isLocal: false,
            };
          }
          console.log("[Location:saveLocation:bg] 9. Calling onLocationUpdate (after sync)");
          onLocationUpdate();

          const remaining = await getPendingLocationsForUser(authUser.id);
          if (remaining.length > 0) {
            console.log("[Location:saveLocation:bg] 10. Syncing remaining pending", { count: remaining.length });
            for (const loc of remaining) {
              const { data: inserted, error } = await supabase
                .from("locations")
                .insert({
                  user_id: loc.user_id,
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  timestamp: loc.timestamp,
                  wait_time: loc.wait_time,
                })
                .select()
                .single();
              if (!error && inserted) {
                await deletePendingLocation(loc.id);
                if (lastLocationRef.current?.id === loc.id) {
                  lastLocationRef.current = {
                    lat: inserted.latitude,
                    lng: inserted.longitude,
                    id: inserted.id,
                    timestamp: inserted.timestamp,
                    isLocal: false,
                  };
                }
              }
            }
            onLocationUpdate();
          }
        } catch (err) {
          console.error("[Location:saveLocation:bg] Error:", err);
        }
      })();
    } catch (error) {
      console.error("[Location:saveLocation] Error:", error);
    }
  }, [user, supabase, onLocationUpdate]);

  const startTracking = useCallback(async () => {
    console.log("[Location:startTracking] 0. Entry", { hasUser: !!user, isNative: isNativePlatform(), hasGeolocation: typeof navigator !== "undefined" && !!navigator?.geolocation });
    if (!user) {
      setError("Please sign in to track your location");
      return;
    }

    if (!isNativePlatform() && !navigator.geolocation) {
      setError("Geolocation is not supported by your browser");
      return;
    }

    console.log("[Location:startTracking] 0a. Checking permission status...");
    const status = await checkPermissionStatus();
    console.log("[Location:startTracking] 0b. Permission status", { status });
    if (status === "denied") {
      setError(
        isNativePlatform()
          ? "Location permission was denied. Enable it in Settings > Privacy > Location."
          : "Location permission was denied. Please enable location access in your browser settings."
      );
      return;
    }

    console.log("[Location:startTracking] 0c. Setting isRequesting(true)");
    setIsRequesting(true);
    setError(null);

    let requestTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const REQUEST_TIMEOUT_MS = 25000;
    requestTimeoutId = setTimeout(() => {
      console.warn("[Location:startTracking] Timeout: getCurrentPosition did not resolve within", REQUEST_TIMEOUT_MS, "ms — unfreezing button");
      setIsRequesting(false);
      requestTimeoutId = null;
    }, REQUEST_TIMEOUT_MS);

    const clearRequestTimeout = () => {
      if (requestTimeoutId !== null) {
        clearTimeout(requestTimeoutId);
        requestTimeoutId = null;
      }
    };

    try {
      console.log("[Location:startTracking] 1. Fetching last location (remote + pending)");
      const [remoteResult, pendingList] = await Promise.all([
        supabase
          .from("locations")
          .select("id, latitude, longitude, timestamp, wait_time")
          .eq("user_id", user.id)
          .order("timestamp", { ascending: false })
          .limit(1)
          .maybeSingle(),
        getPendingLocationsForUser(user.id),
      ]);

      const remote = remoteResult.data;
      const pendingSorted = pendingList
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const lastPending = pendingSorted[0];
      console.log("[Location:startTracking] 2. Last location", {
        hasRemote: !!remote,
        remoteId: remote?.id,
        pendingCount: pendingList.length,
        lastPendingId: lastPending?.id,
      });

      const remoteTime = remote ? new Date(remote.timestamp).getTime() : 0;
      const pendingTime = lastPending ? new Date(lastPending.timestamp).getTime() : 0;

      if (pendingTime >= remoteTime && lastPending) {
        lastLocationRef.current = {
          lat: lastPending.latitude,
          lng: lastPending.longitude,
          id: lastPending.id,
          timestamp: lastPending.timestamp,
          isLocal: true,
          wait_time: lastPending.wait_time,
        };
        console.log("[Location:startTracking] 3. Using last pending as ref");
      } else if (remote) {
        lastLocationRef.current = {
          lat: remote.latitude,
          lng: remote.longitude,
          id: remote.id,
          timestamp: remote.timestamp,
          isLocal: false,
        };
        console.log("[Location:startTracking] 3. Using last remote as ref");
      } else {
        lastLocationRef.current = null;
        console.log("[Location:startTracking] 3. No last location");
      }
    } catch (e) {
      console.log("[Location:startTracking] Error fetching last location", e);
      lastLocationRef.current = null;
    }

    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: isIOSSafari() ? 10000 : 0,
      timeout: isIOSSafari() ? 15000 : 10000,
    };
    console.log("[Location:startTracking] 4. geoOptions", geoOptions);

    const onPosition = (latitude: number, longitude: number) => {
      setCurrentLocation({ lat: latitude, lng: longitude });
      const now = Date.now();
      const shouldSave =
        lastSaveTimeRef.current === null ||
        now - lastSaveTimeRef.current >= TRACKING_INTERVAL_MS;
      if (shouldSave) {
        lastSaveTimeRef.current = now;
        saveLocation(latitude, longitude);
      }
    };

    if (isNativePlatform()) {
      console.log("[Location:startTracking] 5. Native path: CapGeolocation.getCurrentPosition");
      try {
        const position = await CapGeolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 10000,
        });
        const { latitude, longitude } = position.coords;
        setCurrentLocation({ lat: latitude, lng: longitude });
        lastSaveTimeRef.current = Date.now();
        saveLocation(latitude, longitude);
        setIsTracking(true);
        setPermissionStatus("granted");

        const watchId = await CapGeolocation.watchPosition(
          {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 5000,
          },
          (position, err) => {
            if (err) {
              console.error("Error watching location:", err);
              setError("Error tracking location. Please check permissions.");
              setPermissionStatus("denied");
              setIsTracking(false);
              return;
            }
            if (position?.coords) {
              onPosition(position.coords.latitude, position.coords.longitude);
            }
          }
        );
        watchIdRef.current = watchId;
        clearRequestTimeout();
      } catch (err: unknown) {
        console.log("[Location:startTracking] Native getCurrentPosition error", err);
        clearRequestTimeout();
        setIsRequesting(false);
        setIsTracking(false);
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Unable to get location.";
        if (message.includes("denied") || message.includes("Permission")) {
          setPermissionStatus("denied");
        }
        setError(
          message.includes("denied")
            ? "Location permission was denied. Enable it in Settings > Privacy > Location."
            : message
        );
      } finally {
        setIsRequesting(false);
      }
      return;
    }

    // Web: use navigator.geolocation
    console.log("[Location:startTracking] 5. Web path: calling navigator.geolocation.getCurrentPosition", { timeout: geoOptions.timeout });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log("[Location:startTracking] 6. getCurrentPosition SUCCESS", { lat: position.coords.latitude, lng: position.coords.longitude });
        clearRequestTimeout();
        const { latitude, longitude } = position.coords;
        setCurrentLocation({ lat: latitude, lng: longitude });
        lastSaveTimeRef.current = Date.now();
        saveLocation(latitude, longitude);
        setIsTracking(true);
        setIsRequesting(false);
        setPermissionStatus("granted");

        const watchOptions: PositionOptions = {
          enableHighAccuracy: true,
          maximumAge: isIOSSafari() ? 5000 : 0,
          timeout: isIOSSafari() ? 15000 : 10000,
        };

        watchIdRef.current = navigator.geolocation.watchPosition(
          (pos) => {
            const { latitude, longitude } = pos.coords;
            onPosition(latitude, longitude);
          },
          (error) => {
            console.error("[Location:startTracking] watchPosition error", error);
            if (error.code === error.PERMISSION_DENIED) setPermissionStatus("denied");
            setError("Error tracking location.");
            setIsTracking(false);
            if (watchIdRef.current !== null) {
              navigator.geolocation.clearWatch(watchIdRef.current as number);
              watchIdRef.current = null;
            }
          },
          watchOptions
        );
      },
      (error) => {
        console.log("[Location:startTracking] 6. getCurrentPosition ERROR", { code: error.code, message: error.message, PERMISSION_DENIED: error.PERMISSION_DENIED });
        clearRequestTimeout();
        setIsRequesting(false);
        setIsTracking(false);
        if (error.code === error.PERMISSION_DENIED) {
          setPermissionStatus("denied");
          setError(
            isIOSSafari()
              ? "On iOS, go to Settings > Safari > Location Services and enable location access for this site."
              : "Please enable location access in your browser settings."
          );
        } else {
          setError("Unable to get your location. Please try again.");
        }
      },
      geoOptions
    );
    console.log("[Location:startTracking] 5b. getCurrentPosition called (waiting for browser callback)");
  }, [user, supabase, saveLocation]);

  const stopTracking = useCallback(async () => {
    setIsTracking(false);
    setError(null);
    if (watchIdRef.current !== null) {
      if (isNativePlatform()) {
        await CapGeolocation.clearWatch({ id: watchIdRef.current as string });
      } else {
        navigator.geolocation.clearWatch(watchIdRef.current as number);
      }
      watchIdRef.current = null;
    }
    lastLocationRef.current = null;
    lastSaveTimeRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      const id = watchIdRef.current;
      if (id !== null) {
        if (isNativePlatform()) {
          CapGeolocation.clearWatch({ id: id as string }).catch(() => {});
        } else {
          navigator.geolocation.clearWatch(id as number);
        }
      }
    };
  }, []);

  const handleToggleTracking = () => {
    console.log("[Location:button] handleToggleTracking clicked", { isTracking, isRequesting });
    if (isTracking) {
      stopTracking();
    } else {
      startTracking();
    }
  };

  return (
    <div className="absolute top-4 right-4 z-[1000] flex flex-col gap-2">
      <button
        onClick={handleToggleTracking}
        disabled={isRequesting}
        className={`px-4 py-2 rounded-md text-white font-medium shadow-lg transition-opacity ${
          isTracking
            ? "bg-red-500 hover:bg-red-600"
            : "bg-green-500 hover:bg-green-600"
        } ${isRequesting ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        {isRequesting ? "Requesting..." : isTracking ? "Stop Tracking" : "Start Tracking"}
      </button>
      
      {permissionStatus === "denied" && !error && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 px-3 py-2 rounded-md shadow-lg text-sm max-w-xs">
          <p className="text-yellow-800 dark:text-yellow-200 text-xs">
            Location permission denied. {isIOSSafari() && "Go to Settings > Safari > Location Services to enable."}
          </p>
        </div>
      )}
      
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 rounded-md shadow-lg text-sm max-w-xs">
          <p className="text-red-800 dark:text-red-200 text-xs">{error}</p>
        </div>
      )}
      
      {currentLocation && isTracking && (
        <div className="bg-white dark:bg-zinc-900 px-3 py-2 rounded-md shadow-lg text-sm">
          <p className="text-gray-600 dark:text-gray-400">Current Location:</p>
          <p className="font-mono text-xs">
            {currentLocation.lat.toFixed(6)}, {currentLocation.lng.toFixed(6)}
          </p>
        </div>
      )}
    </div>
  );
}

// Calculate distance between two coordinates in degrees
const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const latDiff = lat1 - lat2;
  const lngDiff = lng1 - lng2;
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
};

// Group photos by proximity for clustering using a hierarchical clustering algorithm
// This allows clusters to merge with other clusters if they're close enough
const groupPhotosByProximity = (photos: Photo[], threshold: number): Array<{ photos: Photo[]; center: [number, number] }> => {
  if (photos.length === 0) return [];
  
  // Step 1: Initial clustering - group photos that are very close together
  const initialGroups: Array<{ photos: Photo[]; center: [number, number] }> = [];
  const assigned = new Set<string>();

  // Process each photo
  photos.forEach((photo) => {
    // Skip if already assigned to a cluster
    if (assigned.has(photo.id)) return;

    // Find all unassigned photos within threshold distance
    const nearbyPhotos: Photo[] = [photo];
    assigned.add(photo.id);

    // Use a queue to find all connected photos (transitive closure)
    const queue = [photo];
    
    while (queue.length > 0) {
      const currentPhoto = queue.shift()!;
      
      photos.forEach((otherPhoto) => {
        if (assigned.has(otherPhoto.id)) return;
        
        const distance = getDistance(
          currentPhoto.latitude,
          currentPhoto.longitude,
          otherPhoto.latitude,
          otherPhoto.longitude
        );
        
        // Cluster if within threshold OR if coordinates are essentially identical (within floating point precision)
        const isSameLocation = Math.abs(currentPhoto.latitude - otherPhoto.latitude) < 0.000001 && 
                               Math.abs(currentPhoto.longitude - otherPhoto.longitude) < 0.000001;
        
        if (distance <= threshold || isSameLocation) {
          nearbyPhotos.push(otherPhoto);
          assigned.add(otherPhoto.id);
          queue.push(otherPhoto);
        }
      });
    }

    // Calculate center of the cluster
    const avgLat = nearbyPhotos.reduce((sum, p) => sum + p.latitude, 0) / nearbyPhotos.length;
    const avgLng = nearbyPhotos.reduce((sum, p) => sum + p.longitude, 0) / nearbyPhotos.length;

    initialGroups.push({
      photos: nearbyPhotos,
      center: [avgLat, avgLng],
    });
  });

  // Step 2: Merge clusters that are close enough to each other
  // Use a hierarchical approach - keep merging until no more merges are possible
  let groups = [...initialGroups];
  let merged = true;
  
  while (merged) {
    merged = false;
    const newGroups: Array<{ photos: Photo[]; center: [number, number] }> = [];
    const processed = new Set<number>();
    
    for (let i = 0; i < groups.length; i++) {
      if (processed.has(i)) continue;
      
      let currentGroup = { ...groups[i] };
      processed.add(i);
      
      // Check if this group can merge with any other unprocessed group
      for (let j = i + 1; j < groups.length; j++) {
        if (processed.has(j)) continue;
        
        const distance = getDistance(
          currentGroup.center[0],
          currentGroup.center[1],
          groups[j].center[0],
          groups[j].center[1]
        );
        
        // If clusters are close enough, merge them
        if (distance <= threshold) {
          // Merge the groups
          currentGroup.photos = [...currentGroup.photos, ...groups[j].photos];
          
          // Recalculate center
          const avgLat = currentGroup.photos.reduce((sum, p) => sum + p.latitude, 0) / currentGroup.photos.length;
          const avgLng = currentGroup.photos.reduce((sum, p) => sum + p.longitude, 0) / currentGroup.photos.length;
          currentGroup.center = [avgLat, avgLng];
          
          processed.add(j);
          merged = true;
        }
      }
      
      newGroups.push(currentGroup);
    }
    
    // Also add any unprocessed groups
    for (let i = 0; i < groups.length; i++) {
      if (!processed.has(i)) {
        newGroups.push(groups[i]);
      }
    }
    
    groups = newGroups;
  }

  return groups;
};

// Component to track zoom level
function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const updateZoom = () => {
      const currentZoom = map.getZoom();
      onZoomChange(currentZoom);
    };

    // Listen to both zoom and zoomend for more responsive updates
    map.on("zoom", updateZoom);
    map.on("zoomend", updateZoom);
    map.on("zoomstart", updateZoom); // Also listen to zoom start for immediate feedback
    updateZoom(); // Initial zoom

    return () => {
      map.off("zoom", updateZoom);
      map.off("zoomend", updateZoom);
      map.off("zoomstart", updateZoom);
    };
  }, [map, onZoomChange]);

  return null;
}

// Component to track viewport and calculate viewport-based clustering threshold
function ViewportTracker({ onThresholdChange }: { onThresholdChange: (threshold: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const calculateThreshold = () => {
      const bounds = map.getBounds();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      
      // Calculate viewport size in degrees
      const latSpan = ne.lat - sw.lat;
      const lngSpan = ne.lng - sw.lng;
      
      // Use the smaller dimension to ensure clusters are proportional
      const viewportSize = Math.min(latSpan, lngSpan);
      
      // Cluster threshold should be a percentage of the viewport
      // Using 3-5% of viewport size as the clustering threshold
      // This means a cluster circle should take up roughly 3-5% of the visible map
      // Adjust this percentage to make clustering more or less aggressive
      const clusterPercentage = 0.04; // 4% of viewport
      const threshold = viewportSize * clusterPercentage;
      
      onThresholdChange(threshold);
    };

    // Calculate on map events that change the viewport
    map.on("moveend", calculateThreshold);
    map.on("zoomend", calculateThreshold);
    map.on("resize", calculateThreshold);
    calculateThreshold(); // Initial calculation

    return () => {
      map.off("moveend", calculateThreshold);
      map.off("zoomend", calculateThreshold);
      map.off("resize", calculateThreshold);
    };
  }, [map, onThresholdChange]);

  return null;
}

// Component to render photo markers - separated to force re-render on zoom changes
function PhotoMarkers({ 
  photoGroups, 
  focusLocation, 
  user,
  zoomLevel
}: { 
  photoGroups: Array<{ photos: Photo[]; center: [number, number] }>;
  focusLocation: { latitude: number; longitude: number } | null;
  user: User | null;
  zoomLevel: number;
}) {
  return (
    <>
      {photoGroups.map((group, groupIndex) => {
        // Ensure we only render one marker per group
        if (group.photos.length === 1) {
          // Single photo - show individual marker (not clustered)
          const photo = group.photos[0];
          const isFocused = !!focusLocation && 
            Math.abs(photo.latitude - focusLocation.latitude) < 0.0001 &&
            Math.abs(photo.longitude - focusLocation.longitude) < 0.0001;
          
          return (
            <Marker
              key={`photo-${photo.id}-z${zoomLevel}`}
              position={[photo.latitude, photo.longitude]}
              icon={createPhotoIcon(isFocused)}
            >
              <PhotoPopup photo={photo} user={user} />
            </Marker>
          );
        } else {
          // Multiple photos - show ONLY cluster marker (individual photos are hidden)
          // Create a unique key based on photo IDs and zoom to ensure proper re-rendering
          const photoIds = group.photos.map(p => p.id).sort().join('-');
          return (
            <Marker
              key={`cluster-${photoIds}-${groupIndex}-z${zoomLevel}`}
              position={group.center}
              icon={createClusterIcon(group.photos.length)}
            >
              <ClusterPopup photos={group.photos} user={user} />
            </Marker>
          );
        }
      })}
    </>
  );
}

function ClusterPopup({ photos, user }: { photos: Photo[]; user: User | null }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageUrls, setImageUrls] = useState<{ [key: string]: string | null }>({});
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});
  const loadedPhotosRef = useRef<Set<string>>(new Set());
  const supabase = createClient();

  const currentPhoto = photos[currentIndex];

  // Reset loaded photos when photos array changes
  useEffect(() => {
    loadedPhotosRef.current.clear();
    setImageUrls({});
    setLoading({});
    setCurrentIndex(0);
  }, [photos.map(p => p.id).join(',')]);

  useEffect(() => {
    const loadImages = async () => {
      // Check which photos need to be loaded
      const photosToLoad = photos.filter((p) => {
        // Load if we haven't loaded this photo yet
        return !loadedPhotosRef.current.has(p.id);
      });

      if (photosToLoad.length === 0) return;

      // Mark photos as being loaded
      photosToLoad.forEach((photo) => {
        loadedPhotosRef.current.add(photo.id);
        setLoading((prev) => ({ ...prev, [photo.id]: true }));
      });

      // Mark photos as loading
      photosToLoad.forEach((photo) => {
        setLoading((prev) => ({ ...prev, [photo.id]: true }));
      });

      // Load all photos in parallel
      await Promise.all(
        photosToLoad.map(async (photo) => {
          try {
            // If URL is already provided, use it
            if (photo.url) {
              setImageUrls((prev) => ({ ...prev, [photo.id]: photo.url || null }));
              setLoading((prev) => ({ ...prev, [photo.id]: false }));
              return;
            }

            // If we have storage_path and user, check local cache first — only download if we don't have it
            if (photo.storage_path && user) {
              // Security check: Ensure storage_path starts with user ID
              if (!photo.storage_path.startsWith(`${user.id}/`)) {
                console.error(`Security: Photo ${photo.id} storage_path doesn't match user ID`);
                setImageUrls((prev) => ({ ...prev, [photo.id]: null }));
                setLoading((prev) => ({ ...prev, [photo.id]: false }));
                return;
              }

              const localUrl = await getCachedImage(photo.id);
              if (localUrl) {
                setImageUrls((prev) => ({ ...prev, [photo.id]: localUrl }));
                setLoading((prev) => ({ ...prev, [photo.id]: false }));
                return;
              }

              const { data: urlData, error } = await supabase.storage
                .from("photos")
                .createSignedUrl(photo.storage_path, 3600);

              if (error) throw error;
              if (urlData?.signedUrl) {
                const cachedUrl = await fetchImageWithCache(photo.id, urlData.signedUrl);
                setImageUrls((prev) => ({ ...prev, [photo.id]: cachedUrl }));
              } else {
                setImageUrls((prev) => ({ ...prev, [photo.id]: null }));
              }
            } else {
              // No storage_path or user, mark as failed
              setImageUrls((prev) => ({ ...prev, [photo.id]: null }));
            }
          } catch (error) {
            console.error(`Error loading photo URL for ${photo.id}:`, error);
            setImageUrls((prev) => ({ ...prev, [photo.id]: null }));
          } finally {
            setLoading((prev) => ({ ...prev, [photo.id]: false }));
          }
        })
      );
    };

    loadImages();
  }, [photos, user, supabase]);

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0));
  };

  const currentImageUrl = imageUrls[currentPhoto.id];
  const isLoading = loading[currentPhoto.id];

  return (
    <Popup maxWidth={300} className="cluster-popup">
      <div className="p-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Photo {currentIndex + 1} of {photos.length}
          </span>
          {photos.length > 1 && (
            <div className="flex gap-1">
              <button
                onClick={goToPrevious}
                className="px-2 py-1 bg-purple-500 hover:bg-purple-600 text-white rounded text-xs font-medium"
                title="Previous"
              >
                ←
              </button>
              <button
                onClick={goToNext}
                className="px-2 py-1 bg-purple-500 hover:bg-purple-600 text-white rounded text-xs font-medium"
                title="Next"
              >
                →
              </button>
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center w-64 h-48 bg-gray-100 dark:bg-zinc-800 rounded">
            <p className="text-gray-500 dark:text-gray-400 text-sm">Loading image...</p>
          </div>
        ) : currentImageUrl ? (
          <img
            src={currentImageUrl}
            alt={`Photo from ${new Date(currentPhoto.timestamp).toLocaleDateString()}`}
            className="w-64 h-auto rounded object-cover"
            style={{ maxHeight: "400px" }}
          />
        ) : (
          <div className="flex items-center justify-center w-64 h-48 bg-gray-100 dark:bg-zinc-800 rounded">
            <p className="text-gray-500 dark:text-gray-400 text-sm">Image not available</p>
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
          {new Date(currentPhoto.timestamp).toLocaleString()}
        </p>
        {photos.length > 1 && (
          <div className="mt-2 flex justify-center gap-1">
            {photos.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentIndex(index)}
                className={`w-2 h-2 rounded-full ${
                  index === currentIndex
                    ? "bg-purple-500"
                    : "bg-gray-300 dark:bg-gray-600"
                }`}
                title={`Go to photo ${index + 1}`}
              />
            ))}
          </div>
        )}
      </div>
    </Popup>
  );
}

function PhotoPopup({ photo, user }: { photo: Photo; user: User | null }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    const loadImage = async () => {
      // If URL is already provided, use it
      if (photo.url) {
        setImageUrl(photo.url);
        return;
      }

      // If we have storage_path and user, create signed URL
      if (photo.storage_path && user) {
        setLoading(true);
        try {
          // Security check: Ensure storage_path starts with user ID
          if (!photo.storage_path.startsWith(`${user.id}/`)) {
            console.error(`Security: Photo ${photo.id} storage_path doesn't match user ID`);
            setLoading(false);
            return;
          }

          // Use local cache first — only create signed URL and download if we don't have it
          const localUrl = await getCachedImage(photo.id);
          if (localUrl) {
            setImageUrl(localUrl);
            setLoading(false);
            return;
          }

          const { data: urlData, error } = await supabase.storage
            .from("photos")
            .createSignedUrl(photo.storage_path, 3600);

          if (error) throw error;
          if (urlData?.signedUrl) {
            const cachedUrl = await fetchImageWithCache(photo.id, urlData.signedUrl);
            setImageUrl(cachedUrl);
          }
        } catch (error) {
          console.error("Error loading photo URL:", error);
        } finally {
          setLoading(false);
        }
      }
    };

    loadImage();
  }, [photo.url, photo.storage_path, photo.id, user, supabase]);

  return (
    <Popup maxWidth={300} className="photo-popup">
      <div className="p-2">
        {loading ? (
          <div className="flex items-center justify-center w-64 h-48 bg-gray-100 dark:bg-zinc-800 rounded">
            <p className="text-gray-500 dark:text-gray-400 text-sm">Loading image...</p>
          </div>
        ) : imageUrl ? (
          <img
            src={imageUrl}
            alt={`Photo from ${new Date(photo.timestamp).toLocaleDateString()}`}
            className="w-64 h-auto rounded object-cover"
            style={{ maxHeight: "400px" }}
          />
        ) : (
          <div className="flex items-center justify-center w-64 h-48 bg-gray-100 dark:bg-zinc-800 rounded">
            <p className="text-gray-500 dark:text-gray-400 text-sm">Image not available</p>
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
          {new Date(photo.timestamp).toLocaleString()}
        </p>
      </div>
    </Popup>
  );
}

function MapController({ center, zoom }: { center: [number, number]; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom || map.getZoom());
  }, [center, zoom, map]);
  return null;
}

export default function Map({ user, locations, photos = [], onLocationUpdate, focusLocation }: MapProps) {
  console.log("[Location:Map] render", { locationsCount: locations.length, firstTimestamp: locations[0]?.timestamp?.slice(0, 19), lastTimestamp: locations[locations.length - 1]?.timestamp?.slice(0, 19) });

  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]); // Default to London
  const [zoomLevel, setZoomLevel] = useState<number>(13);
  const [viewportThreshold, setViewportThreshold] = useState<number>(0.0004); // Default threshold

  useEffect(() => {
    if (locations.length > 0) {
      const lastLocation = locations[locations.length - 1];
      setMapCenter([lastLocation.lat, lastLocation.lng]);
      return;
    }
    const setCenterFromCurrentPosition = (lat: number, lng: number) => {
      setMapCenter([lat, lng]);
    };
    if (isNativePlatform()) {
      CapGeolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
        .then((position) => {
          setCenterFromCurrentPosition(position.coords.latitude, position.coords.longitude);
        })
        .catch(() => {});
      return;
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setCenterFromCurrentPosition(position.coords.latitude, position.coords.longitude);
        },
        () => {}
      );
    }
  }, [locations]);

  // Focus on photo location when provided
  useEffect(() => {
    if (focusLocation) {
      setMapCenter([focusLocation.latitude, focusLocation.longitude]);
    }
  }, [focusLocation]);

  // Force recalculation of clustering on every viewport/zoom change
  // The threshold is now based on viewport size (percentage of visible map):
  // - More zoomed in = smaller viewport = smaller threshold = items must be closer to cluster
  // - More zoomed out = larger viewport = larger threshold = items can be further apart to cluster
  // This ensures clusters are proportional to what the user can see
  const photoGroups = useMemo(() => {
    if (photos.length === 0) return [];
    
    // Use viewport-based threshold instead of zoom-based
    // Ensure minimum threshold to catch photos at exact same location
    const threshold = Math.max(viewportThreshold, 0.00001);
    const groups = groupPhotosByProximity(photos, threshold);
    
    // Debug logging
    console.log(`[Clustering] Zoom: ${zoomLevel}, Viewport Threshold: ${threshold.toFixed(6)} degrees, Photos: ${photos.length}, Groups: ${groups.length}`);
    groups.forEach((group, idx) => {
      if (group.photos.length > 1) {
        console.log(`[Clustering] Group ${idx}: ${group.photos.length} photos at (${group.center[0].toFixed(6)}, ${group.center[1].toFixed(6)})`);
      }
    });
    
    // Validation: Ensure each photo appears in exactly one group
    const photoIds = new Set<string>();
    groups.forEach(group => {
      group.photos.forEach(photo => {
        if (photoIds.has(photo.id)) {
          console.warn(`Photo ${photo.id} appears in multiple clusters!`);
        }
        photoIds.add(photo.id);
      });
    });
    
    // Ensure all photos are accounted for
    if (photoIds.size !== photos.length) {
      console.warn(`Clustering mismatch: ${photoIds.size} photos in clusters vs ${photos.length} total photos`);
    }
    
    return groups;
  }, [photos, viewportThreshold, zoomLevel]);

  // Filter out locations that fall within photo clusters
  const visibleLocations = useMemo((): Location[] => {
    if (photoGroups.length === 0) return locations;
    
    const threshold = Math.max(viewportThreshold, 0.00001);
    const excludedLocations = new Set<string>();
    
    // Check each location against each photo cluster
    locations.forEach((location, index) => {
      photoGroups.forEach((group) => {
        // For clusters, check distance from location to cluster center
        if (group.photos.length > 1) {
          const distance = getDistance(
            location.lat,
            location.lng,
            group.center[0],
            group.center[1]
          );
          if (distance <= threshold) {
            excludedLocations.add(`location-${index}`);
          }
        } else {
          // For individual photos, check distance from location to photo
          const photo = group.photos[0];
          const distance = getDistance(
            location.lat,
            location.lng,
            photo.latitude,
            photo.longitude
          );
          if (distance <= threshold) {
            excludedLocations.add(`location-${index}`);
          }
        }
      });
    });
    
    return locations.filter((_, index) => !excludedLocations.has(`location-${index}`));
  }, [locations, photoGroups, viewportThreshold]);

  // Timeline and path: use local cache when data unchanged so we don't recompute every time
  const timelineData = useMemo(() => {
    const pathCoordinates: [number, number][] = visibleLocations.map((loc) => [loc.lat, loc.lng]);

    const cacheKey =
      hashTimelineInput(
        locations,
        photos.map((p) => ({
          id: p.id,
          timestamp: p.timestamp,
          latitude: p.latitude,
          longitude: p.longitude,
        }))
      ) +
      "_" +
      viewportThreshold +
      "_" +
      zoomLevel;

    if (user?.id) {
      const cached = getTimelineCacheSync(user.id, cacheKey);
      if (cached) {
        return { connections: cached.connections, pathCoordinates: cached.pathCoordinates };
      }
    }

    const connections: Array<{ from: [number, number]; to: [number, number] }> = [];
    interface TimelineEvent {
      position: [number, number];
      timestamp: number;
      type: "photo" | "location";
    }
    const events: TimelineEvent[] = [];

    photoGroups.forEach((group) => {
      const photoPosition: [number, number] =
        group.photos.length > 1 ? group.center : [group.photos[0].latitude, group.photos[0].longitude];
      const photoTimestamps = group.photos.map((p) => new Date(p.timestamp).getTime());
      const earliestPhotoTime = Math.min(...photoTimestamps);
      events.push({ position: photoPosition, timestamp: earliestPhotoTime, type: "photo" });
    });

    locations.forEach((location) => {
      events.push({
        position: [location.lat, location.lng],
        timestamp: new Date(location.timestamp).getTime(),
        type: "location",
      });
    });

    events.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < events.length - 1; i++) {
      connections.push({ from: events[i].position, to: events[i + 1].position });
    }

    if (user?.id) {
      setTimelineCacheSync(user.id, cacheKey, { connections, pathCoordinates });
    }
    return { connections, pathCoordinates };
  }, [photoGroups, locations, visibleLocations, viewportThreshold, zoomLevel, user?.id, photos]);

  const timelineConnections = timelineData.connections;
  const pathCoordinates = timelineData.pathCoordinates;

  // Use ALL locations for the breadcrumb trail line so new points always show (visibleLocations
  // excludes points near photos, which hid new breadcrumbs when near a photo)
  const pathCoordinatesFull = useMemo(
    () => locations.map((loc) => [loc.lat, loc.lng] as [number, number]),
    [locations]
  );

  console.log("[Location:Map] trail data", {
    pathCoordinatesCount: pathCoordinates.length,
    pathCoordinatesFullCount: pathCoordinatesFull.length,
    timelineConnectionsCount: timelineConnections.length,
  });

  return (
    <div className="w-full h-full relative">
      <MapContainer
        center={mapCenter}
        zoom={13}
        style={{ height: "100%", width: "100%" }}
        className="z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapController center={mapCenter} zoom={focusLocation ? 15 : undefined} />
        <ZoomTracker onZoomChange={setZoomLevel} />
        <ViewportTracker onThresholdChange={setViewportThreshold} />
        
        {/* Breadcrumb trail - continuous line connecting ALL points (so new locations always appear) */}
        {pathCoordinatesFull.length > 1 && (
          <Polyline
            key={`breadcrumb-${pathCoordinatesFull.length}-${pathCoordinatesFull[pathCoordinatesFull.length - 1]?.join(",")}`}
            positions={pathCoordinatesFull}
            color="#3b82f6"
            weight={4}
            opacity={0.8}
            smoothFactor={1}
          />
        )}
        
        {/* Timeline connections - sequential lines connecting events chronologically */}
        {timelineConnections.map((connection, index) => (
          <Polyline
            key={`timeline-${index}`}
            positions={[
              connection.from,
              connection.to,
            ]}
            color="#8b5cf6"
            weight={2}
            opacity={0.6}
          />
        ))}
        
        {/* Breadcrumb markers - small dots for each location (excluding those in clusters) */}
        {visibleLocations.map((location, index) => {
          const isStart = index === 0;
          const isEnd = index === visibleLocations.length - 1;
          
          // Use special icons for start and end, breadcrumb dots for the rest
          if (isStart && visibleLocations.length > 1) {
            return (
              <Marker
                key={`start-${index}`}
                position={[location.lat, location.lng]}
                icon={createStartIcon()}
              />
            );
          } else if (isEnd && visibleLocations.length > 1) {
            return (
              <Marker
                key={`end-${index}`}
                position={[location.lat, location.lng]}
                icon={createEndIcon()}
              />
            );
          } else {
            // Regular breadcrumb dots
            return (
              <Marker
                key={`breadcrumb-${index}`}
                position={[location.lat, location.lng]}
                icon={createBreadcrumbIcon("#3b82f6", 6)}
              />
            );
          }
        })}
        
        {/* If only one visible location, show it as a regular marker */}
        {visibleLocations.length === 1 && (
          <Marker
            position={[visibleLocations[0].lat, visibleLocations[0].lng]}
            icon={createBreadcrumbIcon("#3b82f6", 8)}
          />
        )}
        
        {/* Photo location markers - clustered or individual */}
        {/* Key includes zoomLevel and group count to force complete re-render on zoom changes */}
        {photoGroups.length > 0 && (
          <PhotoMarkers 
            key={`photo-markers-z${zoomLevel}-g${photoGroups.length}-${photoGroups.map(g => g.photos.length).join('-')}`}
            photoGroups={photoGroups}
            focusLocation={focusLocation || null}
            user={user}
            zoomLevel={zoomLevel}
          />
        )}
      </MapContainer>
      {user && <LocationTracker user={user} onLocationUpdate={onLocationUpdate} />}
    </div>
  );
}


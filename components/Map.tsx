"use client";

import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import type { User } from "@/lib/types";
import {
  addPendingLocation,
  updatePendingLocation,
  getPendingLocationsForUser,
} from "@/lib/localStore";
import { getActiveTrips, type Trip } from "@/lib/firebase/trips";
import { uploadLocationToFirestore, updateLocationInFirestore } from "@/lib/firebase/locations";
import { getFirebaseFirestore } from "@/lib/firebase";
import { Geolocation } from "@capacitor/geolocation";
import { App } from "@capacitor/app";
import { isNativePlatform } from "@/lib/capacitor";

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

// Friend location: larger bubble, different colour, initials
const FRIEND_MARKER_SIZE = 36;
const createFriendLocationIcon = (initials: string) => {
  return L.divIcon({
    className: "friend-location-marker",
    html: `<div style="width: ${FRIEND_MARKER_SIZE}px; height: ${FRIEND_MARKER_SIZE}px; background-color: #ea580c; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 0 2px rgba(234,88,12,0.4); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 12px; cursor: pointer; pointer-events: auto; line-height: 1;">${initials}</div>`,
    iconSize: [FRIEND_MARKER_SIZE, FRIEND_MARKER_SIZE],
    iconAnchor: [FRIEND_MARKER_SIZE / 2, FRIEND_MARKER_SIZE / 2],
  });
};

interface Location {
  lat: number;
  lng: number;
  timestamp: string;
  wait_time?: number;
  trip_ids?: string[];
}

interface Photo {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  storage_path?: string;
  url?: string;
}

export interface FriendLocation {
  user_id: string;
  display_name: string;
  lat: number;
  lng: number;
  timestamp: string;
  wait_time?: number;
}

interface MapProps {
  user: User | null;
  locations: Location[];
  photos?: Photo[];
  /** Friend locations to show (when they share with you) */
  friendLocations?: FriendLocation[];
  /** Active trips for filtering and coloring locations */
  trips?: Trip[];
  onLocationUpdate: () => void;
  focusLocation?: { latitude: number; longitude: number } | null;
  /** Called when pending locations change so the page can sync to Preferences for the background runner */
  onPendingLocationsChange?: () => void;
  /** Called when tracking state changes (for overlay UI) */
  onTrackingChange?: (state: Omit<MapTrackingHandle, "toggleTracking">) => void;
  /** Called when we save a location (so page can update shared_locations for friends) */
  onLocationSaved?: (lat: number, lng: number, timestamp: string, waitTime?: number) => void;
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

// Check geolocation permission status (native uses Capacitor Geolocation)
const checkPermissionStatus = async (): Promise<PermissionState | null> => {
  if (typeof window === "undefined") return null;
  try {
    if (isNativePlatform()) {
      const { location } = await Geolocation.checkPermissions();
      return location === "granted" ? "granted" : location === "denied" ? "denied" : null;
    }
    if (!navigator.permissions) return null;
    const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return result.state;
  } catch {
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

export interface MapTrackingHandle {
  toggleTracking: () => void;
  isTracking: boolean;
  isRequesting: boolean;
  error: string | null;
  permissionStatus: PermissionState | null;
  currentLocation: { lat: number; lng: number } | null;
}

const LocationTracker = forwardRef<MapTrackingHandle, {
  user: User | null;
  onLocationUpdate: () => void;
  onPendingLocationsChange?: () => void;
  onTrackingChange?: (state: Omit<MapTrackingHandle, "toggleTracking">) => void;
  onLocationSaved?: (lat: number, lng: number, timestamp: string, waitTime?: number) => void;
}>(function LocationTracker({ user, onLocationUpdate, onPendingLocationsChange, onTrackingChange, onLocationSaved }, ref) {
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<PermissionState | null>(null);
  // number = navigator.geolocation watch ID; string = Capacitor Geolocation callback ID
  const watchIdRef = useRef<number | string | null>(null);
  const lastLocationRef = useRef<{
    lat: number;
    lng: number;
    id: string;
    timestamp: string;
    isLocal?: boolean;
    wait_time?: number;
  } | null>(null);
  // Track if we should be tracking (for auto-restart on errors/app state changes)
  const shouldBeTrackingRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Removed TRACKING_INTERVAL_MS - locations are now saved immediately when received

  // Check permission status on mount
  useEffect(() => {
    checkPermissionStatus().then((status) => {
      setPermissionStatus(status);
    });
  }, []);

  const saveLocation = useCallback(async (lat: number, lng: number) => {
    if (!user) return;

    console.log("[Location:update] saveLocation called", { lat, lng });

    try {
      const now = new Date();
      const nowISO = now.toISOString();

      // Check if we have a last location and if it's close enough (update wait_time)
      if (lastLocationRef.current) {
        const distance = calculateDistance(
          lastLocationRef.current.lat,
          lastLocationRef.current.lng,
          lat,
          lng
        );

        if (distance < PROXIMITY_THRESHOLD) {
          const lastTimestamp = new Date(lastLocationRef.current.timestamp);
          const timeDiff = Math.floor((now.getTime() - lastTimestamp.getTime()) / 1000); // seconds

          // Last location is in IndexedDB (pending): update wait_time locally and upload immediately
          if (lastLocationRef.current.isLocal) {
            const newWaitTime = (lastLocationRef.current.wait_time ?? 0) + timeDiff;
            console.log("[Location:update] updating pending wait_time", { id: lastLocationRef.current.id, timeDiff, newWaitTime });
            
            // Also update trip_ids if trips are active
            const activeTrips = await getActiveTrips(user.id);
            const tripIds = activeTrips.map((trip) => trip.id);
            
            await updatePendingLocation(lastLocationRef.current.id, {
              wait_time: newWaitTime,
              timestamp: nowISO,
              latitude: lat,
              longitude: lng,
              trip_ids: tripIds.length > 0 ? tripIds : undefined,
            });
            
            // Upload update to Firebase immediately (non-blocking)
            const db = getFirebaseFirestore();
            if (db) {
              updateLocationInFirestore(db, lastLocationRef.current.id, {
                latitude: lat,
                longitude: lng,
                timestamp: nowISO,
                wait_time: newWaitTime,
                trip_ids: tripIds.length > 0 ? tripIds : undefined,
              }).catch((error) => {
                console.error("[Location:update] Background upload failed (non-critical)", error);
              });
            }
            
            lastLocationRef.current = {
              ...lastLocationRef.current,
              lat,
              lng,
              timestamp: nowISO,
              wait_time: newWaitTime,
            };
            onPendingLocationsChange?.();
            onLocationUpdate();
            onLocationSaved?.(lat, lng, nowISO, newWaitTime);
            return;
          }

          // No remote storage: treat non-local last as stale and add new pending below
        }
      }

      // New location: store in IndexedDB first, then upload immediately
      console.log("[Location:update] adding new pending location", { lat, lng });
      
      // Get active trips to tag this location
      const activeTrips = await getActiveTrips(user.id);
      const tripIds = activeTrips.map((trip) => trip.id);
      
      const pending = await addPendingLocation({
        user_id: user.id,
        latitude: lat,
        longitude: lng,
        timestamp: nowISO,
        wait_time: 0,
        trip_ids: tripIds.length > 0 ? tripIds : undefined,
      });
      
      // Upload to Firebase immediately (non-blocking)
      const db = getFirebaseFirestore();
      if (db) {
        uploadLocationToFirestore(db, pending).catch((error) => {
          console.error("[Location:update] Background upload failed (non-critical)", error);
        });
      }
      
      lastLocationRef.current = {
        lat: pending.latitude,
        lng: pending.longitude,
        id: pending.id,
        timestamp: pending.timestamp,
        isLocal: true,
        wait_time: 0,
      };
      onPendingLocationsChange?.();
      onLocationUpdate();
      onLocationSaved?.(lat, lng, pending.timestamp, 0);
    } catch (error) {
      console.error("Error saving location:", error);
    }
  }, [user, onLocationUpdate, onPendingLocationsChange, onLocationSaved]);

  const startTracking = useCallback(async () => {
    if (!user) {
      setError("Please sign in to track your location");
      return;
    }

    if (!isNativePlatform() && !navigator.geolocation) {
      setError("Geolocation is not supported by your browser");
      return;
    }

    // Check permission status first if available
    const status = await checkPermissionStatus();
    if (status === "denied") {
      setError("Location permission was denied. Please enable location access in your browser settings.");
      return;
    }

    setIsRequesting(true);
    setError(null);

    try {
      const pendingList = await getPendingLocationsForUser(user.id);
      const pendingSorted = [...pendingList].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      const lastPending = pendingSorted[0];
      if (lastPending) {
        lastLocationRef.current = {
          lat: lastPending.latitude,
          lng: lastPending.longitude,
          id: lastPending.id,
          timestamp: lastPending.timestamp,
          isLocal: true,
          wait_time: lastPending.wait_time ?? 0,
        };
      } else {
        lastLocationRef.current = null;
      }
    } catch {
      lastLocationRef.current = null;
    }

    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: isIOSSafari() ? 10000 : 0,
      timeout: isIOSSafari() ? 15000 : 10000,
    };

    const onPosition = (latitude: number, longitude: number) => {
      setCurrentLocation({ lat: latitude, lng: longitude });
      // Save location immediately (no interval check)
      saveLocation(latitude, longitude);
    };

    const clearWatchRef = () => {
      if (watchIdRef.current === null) return;
      if (typeof watchIdRef.current === "string") {
        Geolocation.clearWatch({ id: watchIdRef.current }).catch(() => {});
      } else {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      watchIdRef.current = null;
    };

    if (isNativePlatform()) {
      // Use Capacitor Geolocation so native CLLocationManager can deliver updates in background
      // (with "Always" permission and UIBackgroundModes location). Web navigator.geolocation is suspended when backgrounded.
      try {
        await Geolocation.requestPermissions();
        const pos = await Geolocation.getCurrentPosition(geoOptions);
        const { latitude, longitude } = pos.coords;
        setCurrentLocation({ lat: latitude, lng: longitude });
        saveLocation(latitude, longitude);
        setIsTracking(true);
        setIsRequesting(false);
        setPermissionStatus("granted");

        const watchOptions: PositionOptions = {
          enableHighAccuracy: true,
          maximumAge: isIOSSafari() ? 5000 : 0,
          timeout: isIOSSafari() ? 15000 : 10000,
        };
        const callbackId = await Geolocation.watchPosition(
          watchOptions,
          (position, err) => {
            if (err) {
              console.error("[Location:bg] Error watching location (native):", err);
              // Don't stop tracking for transient errors - only for permission denied
              const errorCode = (err as any)?.code;
              if (errorCode === 1 || errorCode === 'PERMISSION_DENIED') {
                // Permission denied - stop tracking
                console.error("[Location:bg] Permission denied, stopping tracking");
                setError("Location permission was denied. Please enable location access.");
                setIsTracking(false);
                shouldBeTrackingRef.current = false;
                clearWatchRef();
                return;
              }
              // For other errors (timeout, unavailable), log but keep trying
              console.warn("[Location:bg] Transient error, will retry:", err);
              setError(null); // Clear error for transient issues
              // Don't stop tracking - let it retry automatically
              return;
            }
            if (position?.coords) {
              // Clear any previous errors on successful update
              setError(null);
              console.log("[Location:bg] native watchPosition update", {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              });
              onPosition(position.coords.latitude, position.coords.longitude);
            }
          }
        );
        watchIdRef.current = callbackId;
        shouldBeTrackingRef.current = true;
      } catch (err) {
        setIsRequesting(false);
        setIsTracking(false);
        setError(err instanceof Error ? err.message : "Unable to get your location.");
        setPermissionStatus("denied");
      }
      return;
    }

    // Web: navigator.geolocation (suspended when app is backgrounded on iOS)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setCurrentLocation({ lat: latitude, lng: longitude });
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
            // Clear any previous errors on successful update
            setError(null);
            console.log("[Location:bg] web watchPosition update", { lat: latitude, lng: longitude });
            onPosition(latitude, longitude);
          },
          (error) => {
            console.error("[Location:bg] Error watching location:", error);
            // Only stop tracking for permission denied - other errors are transient
            if (error.code === error.PERMISSION_DENIED) {
              console.error("[Location:bg] Permission denied, stopping tracking");
              setError("Location permission was denied. Please enable location access.");
              setPermissionStatus("denied");
              setIsTracking(false);
              shouldBeTrackingRef.current = false;
              clearWatchRef();
            } else {
              // For transient errors (timeout, unavailable), log but keep trying
              console.warn("[Location:bg] Transient error, will continue:", error.code);
              setError(null); // Clear error for transient issues
              // Don't stop tracking - let it retry automatically
            }
          },
          watchOptions
        );
        shouldBeTrackingRef.current = true;
      },
      (error) => {
        setIsRequesting(false);
        setIsTracking(false);
        let errorMessage = "Unable to get your location. ";
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage += "Location permission was denied. ";
            if (isIOSSafari()) {
              errorMessage += "On iOS, go to Settings > Safari > Location Services and enable location access for this site.";
            } else {
              errorMessage += "Please enable location access in your browser settings.";
            }
            setPermissionStatus("denied");
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage += "Location information is unavailable. Please ensure location services are enabled on your device.";
            break;
          case error.TIMEOUT:
            errorMessage += "Location request timed out. Please try again.";
            break;
          default:
            errorMessage += "An unknown error occurred.";
            break;
        }
        setError(errorMessage);
      },
      geoOptions
    );
  }, [user, saveLocation]);

  const stopTracking = useCallback(() => {
    setIsTracking(false);
    setError(null);
    shouldBeTrackingRef.current = false;
    // Clear any retry timeouts
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (watchIdRef.current !== null) {
      if (typeof watchIdRef.current === "string") {
        Geolocation.clearWatch({ id: watchIdRef.current }).catch(() => {});
      } else {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      watchIdRef.current = null;
    }
    lastLocationRef.current = null;
  }, []);

  // Auto-restart tracking if it stops unexpectedly (e.g., due to transient errors)
  useEffect(() => {
    if (!isNativePlatform() || !user) return;
    
    const checkAndRestart = async () => {
      // Only restart if we should be tracking but aren't
      if (shouldBeTrackingRef.current && !isTracking && !isRequesting) {
        console.log("[Location:bg] Tracking stopped unexpectedly, attempting to restart...");
        // Wait a bit before restarting to avoid rapid retries
        retryTimeoutRef.current = setTimeout(() => {
          if (shouldBeTrackingRef.current && !isTracking) {
            console.log("[Location:bg] Restarting tracking...");
            startTracking().catch((err) => {
              console.error("[Location:bg] Failed to restart tracking:", err);
            });
          }
        }, 5000); // Wait 5 seconds before retry
      }
    };

    // Check periodically if tracking stopped unexpectedly
    const intervalId = setInterval(checkAndRestart, 30000); // Check every 30 seconds
    
    return () => {
      clearInterval(intervalId);
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [isTracking, isRequesting, user, startTracking]);

  // Restart tracking when app becomes active if it should be tracking
  useEffect(() => {
    if (!isNativePlatform() || !user) return;
    
    const handleAppStateChange = async (state: { isActive: boolean }) => {
      if (state.isActive && shouldBeTrackingRef.current && !isTracking && !isRequesting) {
        console.log("[Location:bg] App became active, restarting tracking...");
        // Small delay to ensure app is fully active
        setTimeout(() => {
          if (shouldBeTrackingRef.current && !isTracking) {
            startTracking().catch((err) => {
              console.error("[Location:bg] Failed to restart tracking on app active:", err);
            });
          }
        }, 1000);
      }
    };

    const listenerPromise = App.addListener("appStateChange", handleAppStateChange);
    return () => {
      listenerPromise.then((l) => l.remove()).catch(() => {});
    };
  }, [isTracking, isRequesting, user, startTracking]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        if (typeof watchIdRef.current === "string") {
          Geolocation.clearWatch({ id: watchIdRef.current }).catch(() => {});
        } else {
          navigator.geolocation.clearWatch(watchIdRef.current);
        }
        watchIdRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  const handleToggleTracking = useCallback(() => {
    if (isTracking) {
      stopTracking();
    } else {
      startTracking();
    }
  }, [isTracking, startTracking, stopTracking]);

  useImperativeHandle(ref, () => ({
    toggleTracking: handleToggleTracking,
    isTracking,
    isRequesting,
    error,
    permissionStatus,
    currentLocation,
  }), [handleToggleTracking, isTracking, isRequesting, error, permissionStatus, currentLocation]);

  useEffect(() => {
    onTrackingChange?.({
      isTracking,
      isRequesting,
      error,
      permissionStatus,
      currentLocation,
    });
  }, [isTracking, isRequesting, error, permissionStatus, currentLocation, onTrackingChange]);

  return null;
});

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

function ClusterPopup({ photos }: { photos: Photo[]; user: User | null }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentPhoto = photos[currentIndex];
  const imageUrls = useMemo(() => {
    const out: { [key: string]: string | null } = {};
    photos.forEach((p) => { out[p.id] = p.url ?? null; });
    return out;
  }, [photos]);
  const isLoading = currentPhoto ? !imageUrls[currentPhoto.id] && !currentPhoto.url : false;

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0));
  };

  const currentImageUrl = currentPhoto ? (imageUrls[currentPhoto.id] ?? currentPhoto.url) : null;

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

function PhotoPopup({ photo }: { photo: Photo; user: User | null }) {
  const imageUrl = photo.url ?? null;

  return (
    <Popup maxWidth={300} className="photo-popup">
      <div className="p-2">
        {imageUrl ? (
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

export interface MapControlsHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  flyToCurrentLocation: () => void;
}

function MapControlsBridge({ controlRef }: { controlRef: React.RefObject<MapControlsHandle | null> }) {
  const map = useMap();
  useEffect(() => {
    if (!controlRef || typeof controlRef === "function") return;
    (controlRef as React.MutableRefObject<MapControlsHandle | null>).current = {
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
      flyToCurrentLocation: () => {
        if (typeof navigator !== "undefined" && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => map.flyTo([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 14)),
            () => {}
          );
        }
      },
    };
    return () => {
      if (controlRef && typeof controlRef !== "function") (controlRef as React.MutableRefObject<MapControlsHandle | null>).current = null;
    };
  }, [map, controlRef]);
  return null;
}

export interface MapHandle extends MapTrackingHandle, MapControlsHandle {}

function getInitials(displayName: string): string {
  const name = (displayName || "").trim();
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
  }
  return name.slice(0, 2).toUpperCase();
}

// Generate a color for a trip based on its ID (deterministic)
const getTripColor = (tripId: string, index: number): string => {
  // Use a palette of distinct colors
  const colors = [
    "#ef4444", // red
    "#3b82f6", // blue
    "#10b981", // green
    "#f59e0b", // amber
    "#8b5cf6", // purple
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#84cc16", // lime
    "#f97316", // orange
    "#6366f1", // indigo
  ];
  
  // Use index modulo colors length for deterministic color assignment
  return colors[index % colors.length];
};

export default forwardRef<MapHandle, MapProps>(function Map(
  { user, locations, photos = [], friendLocations = [], trips = [], onLocationUpdate, focusLocation, onPendingLocationsChange, onTrackingChange, onLocationSaved },
  ref
) {
  const trackerRef = useRef<MapTrackingHandle | null>(null);
  const mapControlsRef = useRef<MapControlsHandle | null>(null);

  useImperativeHandle(ref, () => ({
    toggleTracking: () => trackerRef.current?.toggleTracking(),
    get isTracking() { return trackerRef.current?.isTracking ?? false; },
    get isRequesting() { return trackerRef.current?.isRequesting ?? false; },
    get error() { return trackerRef.current?.error ?? null; },
    get permissionStatus() { return trackerRef.current?.permissionStatus ?? null; },
    get currentLocation() { return trackerRef.current?.currentLocation ?? null; },
    zoomIn: () => mapControlsRef.current?.zoomIn(),
    zoomOut: () => mapControlsRef.current?.zoomOut(),
    flyToCurrentLocation: () => mapControlsRef.current?.flyToCurrentLocation(),
  }), []);

  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]); // Default to London
  const [zoomLevel, setZoomLevel] = useState<number>(13);
  const [viewportThreshold, setViewportThreshold] = useState<number>(0.0004); // Default threshold

  useEffect(() => {
    if (navigator.geolocation && locations.length === 0) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setMapCenter([position.coords.latitude, position.coords.longitude]);
        },
        () => {
          // Use default center if geolocation fails
        }
      );
    } else if (locations.length > 0) {
      const lastLocation = locations[locations.length - 1];
      setMapCenter([lastLocation.lat, lastLocation.lng]);
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

  // Filter locations: if trips are active, only show trip-based locations
  // Also filter out locations that fall within photo clusters
  const visibleLocations = useMemo((): Location[] => {
    let filtered = locations;
    
    // If at least one trip is active, only show locations that belong to active trips
    const activeTripIds = trips.filter(t => t.is_active).map(t => t.id);
    if (activeTripIds.length > 0) {
      filtered = locations.filter((location) => {
        // Location must have trip_ids and at least one must be in activeTripIds
        return location.trip_ids && location.trip_ids.some(id => activeTripIds.includes(id));
      });
    }
    
    // Filter out locations that fall within photo clusters
    if (photoGroups.length === 0) return filtered;
    
    const threshold = Math.max(viewportThreshold, 0.00001);
    const excludedLocations = new Set<string>();
    
    // Check each location against each photo cluster
    filtered.forEach((location, index) => {
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
    
    return filtered.filter((_, index) => !excludedLocations.has(`location-${index}`));
  }, [locations, trips, photoGroups, viewportThreshold]);
  
  // Group locations by trip_id and create polylines for each trip
  const tripPolylines = useMemo(() => {
    const activeTripIds = trips.filter(t => t.is_active).map(t => t.id);
    
    // If no active trips, return empty array (will show default breadcrumb trail)
    if (activeTripIds.length === 0) {
      return [];
    }
    
    // Group locations by trip_id (using plain object to avoid Map naming conflict)
    const tripGroups: Record<string, Location[]> = {};
    
    visibleLocations.forEach((location) => {
      if (location.trip_ids) {
        location.trip_ids.forEach((tripId) => {
          if (activeTripIds.includes(tripId)) {
            if (!tripGroups[tripId]) {
              tripGroups[tripId] = [];
            }
            tripGroups[tripId].push(location);
          }
        });
      }
    });
    
    // Create polyline data for each trip
    const polylines: Array<{ tripId: string; tripName: string; color: string; positions: [number, number][] }> = [];
    
    trips.forEach((trip, index) => {
      if (trip.is_active && tripGroups[trip.id]) {
        const tripLocations = tripGroups[trip.id];
        // Sort by timestamp to ensure correct order
        tripLocations.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        
        if (tripLocations.length > 1) {
          polylines.push({
            tripId: trip.id,
            tripName: trip.name,
            color: getTripColor(trip.id, index),
            positions: tripLocations.map((loc) => [loc.lat, loc.lng] as [number, number]),
          });
        }
      }
    });
    
    return polylines;
  }, [visibleLocations, trips]);

  // Create sequential timeline connections between events (photos and locations)
  const timelineConnections = useMemo(() => {
    const connections: Array<{ 
      from: [number, number]; 
      to: [number, number];
    }> = [];
    
    // Create a combined timeline of all events (photos and locations) sorted by timestamp
    interface TimelineEvent {
      position: [number, number];
      timestamp: number;
      type: 'photo' | 'location';
    }
    
    const events: TimelineEvent[] = [];
    
    // Add photo groups to timeline
    photoGroups.forEach((group) => {
      const photoPosition: [number, number] = group.photos.length > 1 
        ? group.center 
        : [group.photos[0].latitude, group.photos[0].longitude];
      
      // Use the earliest photo timestamp in the group
      const photoTimestamps = group.photos.map(p => new Date(p.timestamp).getTime());
      const earliestPhotoTime = Math.min(...photoTimestamps);
      
      events.push({
        position: photoPosition,
        timestamp: earliestPhotoTime,
        type: 'photo',
      });
    });
    
    // Add locations to timeline (use visibleLocations which respects trip filtering)
    visibleLocations.forEach((location) => {
      events.push({
        position: [location.lat, location.lng],
        timestamp: new Date(location.timestamp).getTime(),
        type: 'location',
      });
    });
    
    // Sort events by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);
    
    // Connect each event to the next event in chronological order
    for (let i = 0; i < events.length - 1; i++) {
      connections.push({
        from: events[i].position,
        to: events[i + 1].position,
      });
    }
    
    console.log(`[Timeline] Created ${connections.length} sequential connections from ${events.length} events`);
    
    return connections;
  }, [photoGroups, visibleLocations]);

  // Use visibleLocations for path coordinates (only if no active trips)
  // If trips are active, we'll use tripPolylines instead
  const pathCoordinates: [number, number][] = useMemo(() => {
    const activeTripIds = trips.filter(t => t.is_active).map(t => t.id);
    // Only show default breadcrumb trail if no trips are active
    if (activeTripIds.length > 0) {
      return [];
    }
    return visibleLocations.map((loc) => [loc.lat, loc.lng]);
  }, [visibleLocations, trips]);

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
        <MapControlsBridge controlRef={mapControlsRef} />
        <ZoomTracker onZoomChange={setZoomLevel} />
        <ViewportTracker onThresholdChange={setViewportThreshold} />
        
        {/* Trip-based polylines - different color per trip */}
        {tripPolylines.map((polyline) => (
          <Polyline
            key={`trip-${polyline.tripId}`}
            positions={polyline.positions}
            color={polyline.color}
            weight={4}
            opacity={0.8}
            smoothFactor={1}
          />
        ))}
        
        {/* Default breadcrumb trail - only shown when no trips are active */}
        {pathCoordinates.length > 1 && (
          <Polyline 
            positions={pathCoordinates} 
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
          
          // Determine color based on trip_ids if trips are active
          let markerColor = "#3b82f6"; // default blue
          const activeTripIds = trips.filter(t => t.is_active).map(t => t.id);
          if (activeTripIds.length > 0 && location.trip_ids) {
            // Find the first active trip this location belongs to
            const matchingTrip = trips.find(t => t.is_active && location.trip_ids?.includes(t.id));
            if (matchingTrip) {
              const tripIndex = trips.findIndex(t => t.id === matchingTrip.id);
              markerColor = getTripColor(matchingTrip.id, tripIndex);
            }
          }
          
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
            // Regular breadcrumb dots with trip color if applicable
            return (
              <Marker
                key={`breadcrumb-${index}`}
                position={[location.lat, location.lng]}
                icon={createBreadcrumbIcon(markerColor, 6)}
              />
            );
          }
        })}
        
        {/* If only one visible location, show it as a regular marker */}
        {visibleLocations.length === 1 && (() => {
          const location = visibleLocations[0];
          let markerColor = "#3b82f6"; // default blue
          const activeTripIds = trips.filter(t => t.is_active).map(t => t.id);
          if (activeTripIds.length > 0 && location.trip_ids) {
            const matchingTrip = trips.find(t => t.is_active && location.trip_ids?.includes(t.id));
            if (matchingTrip) {
              const tripIndex = trips.findIndex(t => t.id === matchingTrip.id);
              markerColor = getTripColor(matchingTrip.id, tripIndex);
            }
          }
          return (
            <Marker
              key="single-location"
              position={[location.lat, location.lng]}
              icon={createBreadcrumbIcon(markerColor, 8)}
            />
          );
        })()}
        
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

        {/* Friend locations (when they share with you) */}
        {friendLocations.map((fl) => (
          <Marker
            key={fl.user_id}
            position={[fl.lat, fl.lng]}
            icon={createFriendLocationIcon(getInitials(fl.display_name))}
          >
            <Popup>
              <span className="font-semibold">{fl.display_name || "Friend"}</span>
              {fl.wait_time != null && fl.wait_time > 0 && (
                <span className="block text-sm text-muted-foreground">
                  Wait: {Math.floor(fl.wait_time / 60)} min
                </span>
              )}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      {user && (
        <LocationTracker
          ref={trackerRef}
          user={user}
          onLocationUpdate={onLocationUpdate}
          onPendingLocationsChange={onPendingLocationsChange}
          onTrackingChange={onTrackingChange}
          onLocationSaved={onLocationSaved}
        />
      )}
    </div>
  );
});


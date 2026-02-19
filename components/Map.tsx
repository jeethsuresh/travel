"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { createClient } from "@/lib/firebase/client";
import { collection, query, where, orderBy, limit, getDocs, Timestamp } from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";
import {
  addPendingLocation,
  updatePendingLocation,
  getPendingLocationsForUser,
} from "@/lib/localStore";
import { Geolocation } from "@capacitor/geolocation";
import { isNativePlatform } from "@/lib/capacitor";

/** Distance in meters between two lat/lng points (Haversine). */
function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const SAME_LOCATION_RADIUS_M = 100;

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

const createFriendIcon = (color: string) => {
  return L.divIcon({
    className: "friend-marker",
    html: `<div style="width: 14px; height: 14px; background-color: ${color}; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 2px rgba(0,0,0,0.25);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
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

interface FriendLocation {
  friend_id: string;
  friend_email: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}

interface MapProps {
  user: FirebaseUser | null;
  locations: Location[];
  photos?: Photo[];
  friendLocations?: FriendLocation[];
  onLocationUpdate: () => void;
  focusLocation?: { latitude: number; longitude: number } | null;
  /** Called when pending locations change so the page can sync to Preferences for the background runner */
  onPendingLocationsChange?: () => void;
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

function LocationTracker({ user, onLocationUpdate, onPendingLocationsChange }: { user: FirebaseUser | null; onLocationUpdate: () => void; onPendingLocationsChange?: () => void }) {
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<PermissionState | null>(null);
  // number = navigator.geolocation watch ID; string = Capacitor Geolocation callback ID
  const watchIdRef = useRef<number | string | null>(null);
  // Timestamp in ms of the last time we actually persisted a location (for throttling).
  const lastSavedAtRef = useRef<number | null>(null);
  const lastLocationRef = useRef<{
    lat: number;
    lng: number;
    id: string;
    timestamp: string;
    isLocal?: boolean;
    wait_time?: number;
  } | null>(null);
  const { db } = createClient();

  // Check permission status on mount
  useEffect(() => {
    checkPermissionStatus().then((status) => {
      setPermissionStatus(status);
    });
  }, []);

  const saveLocation = useCallback(
    async (lat: number, lng: number) => {
      if (!user) return;

      console.log("[Location:update] saveLocation called", { lat, lng });

      const now = new Date();
      const nowISO = now.toISOString();

      let handledWithUpdate = false;

      // 1) If within 100m of the last location: update wait_time if last was local, else skip (no new entry).
      if (lastLocationRef.current) {
        const distM = distanceMeters(
          lastLocationRef.current.lat,
          lastLocationRef.current.lng,
          lat,
          lng
        );
        if (distM <= SAME_LOCATION_RADIUS_M && !lastLocationRef.current.isLocal) {
          // Last was remote (Firestore); we can't update it, so skip this poll to avoid duplicate entry.
          return;
        }
      }

      if (lastLocationRef.current && lastLocationRef.current.isLocal) {
        try {
          const distM = distanceMeters(
            lastLocationRef.current.lat,
            lastLocationRef.current.lng,
            lat,
            lng
          );
          if (distM <= SAME_LOCATION_RADIUS_M) {
            const lastTimestamp = new Date(lastLocationRef.current.timestamp);
            const timeDiff = Math.floor(
              (now.getTime() - lastTimestamp.getTime()) / 1000
            ); // seconds
            const newWaitTime =
              (lastLocationRef.current.wait_time ?? 0) + timeDiff;

            console.log("[Location:update] updating pending wait_time", {
              id: lastLocationRef.current.id,
              timeDiff,
              newWaitTime,
            });

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

            handledWithUpdate = true;
            onPendingLocationsChange?.();
            onLocationUpdate();
          }
        } catch (err) {
          // Most likely the pending row was deleted (e.g. user cleared storage)
          // while our in-memory ref still points at it. Reset and fall back to
          // creating a fresh pending row instead of failing the whole save.
          const errorInfo =
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err;
          console.error(
            "[Location:update] failed to update pending location; will create new one",
            {
              id: lastLocationRef.current?.id,
              error: errorInfo,
            }
          );
          lastLocationRef.current = null;
        }
      }

      if (handledWithUpdate) {
        return;
      }

      // 2) Otherwise, create a brand new pending location entry.
      try {
        console.log("[Location:update] adding new pending location", {
          lat,
          lng,
        });

        const pending = await addPendingLocation({
          user_id: user.uid,
          latitude: lat,
          longitude: lng,
          timestamp: nowISO,
          wait_time: 0,
        });

        lastLocationRef.current = {
          lat: pending.latitude,
          lng: pending.longitude,
          id: pending.id,
          timestamp: pending.timestamp,
          isLocal: true,
          wait_time: pending.wait_time,
        };

        onPendingLocationsChange?.();
        onLocationUpdate();
      } catch (err) {
        const errorInfo =
          err instanceof Error ? { name: err.name, message: err.message } : err;
        console.error("[Location:update] Error adding new pending location", {
          lat,
          lng,
          error: errorInfo,
        });
      }
    },
    [user, onLocationUpdate, onPendingLocationsChange]
  );

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

    // Fetch last location from both Firestore and IndexedDB (pending) so proximity/wait_time use the true latest
    try {
      const [remoteSnapshot, pendingList] = await Promise.all([
        getDocs(
          query(
            collection(db, "locations"),
            where("user_id", "==", user.uid),
            orderBy("timestamp", "desc"),
            limit(1)
          )
        ),
        getPendingLocationsForUser(user.uid),
      ]);

      const remoteDoc = remoteSnapshot.docs[0];
      const remote = remoteDoc ? {
        id: remoteDoc.id,
        latitude: remoteDoc.data().latitude,
        longitude: remoteDoc.data().longitude,
        timestamp: remoteDoc.data().timestamp instanceof Timestamp 
          ? remoteDoc.data().timestamp.toDate().toISOString() 
          : remoteDoc.data().timestamp,
      } : null;
      const pendingSorted = [...pendingList].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      const lastPending = pendingSorted[0];

      const remoteTime = remote ? new Date(remote.timestamp).getTime() : 0;
      const pendingTime = lastPending ? new Date(lastPending.timestamp).getTime() : 0;

      if (pendingTime >= remoteTime && lastPending) {
        lastLocationRef.current = {
          lat: lastPending.latitude,
          lng: lastPending.longitude,
          id: lastPending.id,
          timestamp: lastPending.timestamp,
          isLocal: true,
          wait_time: lastPending.wait_time ?? 0,
        };
      } else if (remote) {
        lastLocationRef.current = {
          lat: remote.latitude,
          lng: remote.longitude,
          id: remote.id,
          timestamp: remote.timestamp,
        };
      } else {
        lastLocationRef.current = null;
      }
    } catch (error) {
      lastLocationRef.current = null;
    }

    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: isIOSSafari() ? 10000 : 0,
      timeout: isIOSSafari() ? 15000 : 10000,
    };

    const onPosition = (latitude: number, longitude: number) => {
      setCurrentLocation({ lat: latitude, lng: longitude });

      // Throttle persisted updates to at most once every 30 seconds. The native
      // watchers can still fire more frequently, but we don't need to write a new
      // pending row or top up wait_time every single second.
      const nowMs = Date.now();
      const lastSavedMs = lastSavedAtRef.current;
      const THROTTLE_MS = 30_000;
      if (lastSavedMs != null && nowMs - lastSavedMs < THROTTLE_MS) {
        return;
      }
      lastSavedAtRef.current = nowMs;

      // Purely local processing: compare against the last point and either append a new
      // pending row or top up wait_time on the last one. No network calls here.
      void saveLocation(latitude, longitude);
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
        await saveLocation(latitude, longitude);
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
              console.error("Error watching location (native):", err);
              setError("Error tracking location. Please check permissions.");
              setIsTracking(false);
              clearWatchRef();
              return;
            }
            if (position?.coords) {
              console.log("[Location:bg] native watchPosition update", {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              });
              onPosition(position.coords.latitude, position.coords.longitude);
            }
          }
        );
        watchIdRef.current = callbackId;
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
        void saveLocation(latitude, longitude);
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
            console.log("[Location:bg] web watchPosition update", { lat: latitude, lng: longitude });
            onPosition(latitude, longitude);
          },
          (error) => {
            console.error("Error watching location:", error);
            let errorMessage = "Error tracking location. ";
            switch (error.code) {
              case error.PERMISSION_DENIED:
                errorMessage += "Location permission was denied.";
                setPermissionStatus("denied");
                break;
              case error.POSITION_UNAVAILABLE:
                errorMessage += "Location information is unavailable.";
                break;
              case error.TIMEOUT:
                errorMessage += "Location request timed out.";
                break;
              default:
                errorMessage += "Please check your permissions.";
            }
            setError(errorMessage);
            setIsTracking(false);
            clearWatchRef();
          },
          watchOptions
        );
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
  }, [user, db, saveLocation]);

  const stopTracking = useCallback(() => {
    setIsTracking(false);
    setError(null);
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
    };
  }, []);

  const handleToggleTracking = () => {
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
  user: FirebaseUser | null;
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

function ClusterPopup({ photos, user }: { photos: Photo[]; user: FirebaseUser | null }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageUrls, setImageUrls] = useState<{ [key: string]: string | null }>({});
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});
  const loadedPhotosRef = useRef<Set<string>>(new Set());

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

      // All photos now have url from local storage (blob or Capacitor file URL)
      await Promise.all(
        photosToLoad.map(async (photo) => {
          try {
            const url = photo.url || null;
            setImageUrls((prev) => ({ ...prev, [photo.id]: url }));
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
  }, [photos]);

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

function PhotoPopup({ photo }: { photo: Photo; user: FirebaseUser | null }) {
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

export default function Map({ user, locations, photos = [], friendLocations = [], onLocationUpdate, focusLocation, onPendingLocationsChange }: MapProps) {
  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]); // Default to London
  const [zoomLevel, setZoomLevel] = useState<number>(13);
  const [viewportThreshold, setViewportThreshold] = useState<number>(0.0004); // Default threshold
  const hasInitializedCenterRef = useRef(false);
  const friendColorMap = useMemo(() => {
    const palette = [
      "#22c55e",
      "#3b82f6",
      "#eab308",
      "#ec4899",
      "#8b5cf6",
      "#f97316",
      "#14b8a6",
      "#f43f5e",
    ];
    const map: Record<string, string> = {};
    friendLocations.forEach((f, index) => {
      const existing = map[f.friend_id];
      if (!existing) {
        map[f.friend_id] = palette[index % palette.length];
      }
    });
    return map;
  }, [friendLocations]);

  // Ensure locations used for map paths are in chronological order (oldest → newest),
  // even if the caller provides them in a different order (e.g. newest first for the list).
  const sortedLocations = useMemo(
    () =>
      [...locations].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      ),
    [locations]
  );

  useEffect(() => {
    // Only determine the initial map center once.
    if (hasInitializedCenterRef.current) return;

    if (sortedLocations.length > 0) {
      const lastLocation = sortedLocations[sortedLocations.length - 1];
      setMapCenter([lastLocation.lat, lastLocation.lng]);
      hasInitializedCenterRef.current = true;
      return;
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setMapCenter([position.coords.latitude, position.coords.longitude]);
          hasInitializedCenterRef.current = true;
        },
        () => {
          // Use default center if geolocation fails; leave initialized as false
        }
      );
    }
  }, [sortedLocations]);

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
    if (photoGroups.length === 0) return sortedLocations;
    
    const threshold = Math.max(viewportThreshold, 0.00001);
    const excludedLocations = new Set<string>();
    
    // Check each location against each photo cluster
    sortedLocations.forEach((location, index) => {
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
    
    return sortedLocations.filter((_, index) => !excludedLocations.has(`location-${index}`));
  }, [sortedLocations, photoGroups, viewportThreshold]);

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
    
    // Add locations to timeline
    sortedLocations.forEach((location) => {
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
  }, [photoGroups, sortedLocations]);

  // Use visibleLocations for path coordinates (calculated after filtering)
  const pathCoordinates: [number, number][] = useMemo(() => {
    return visibleLocations.map((loc) => [loc.lat, loc.lng]);
  }, [visibleLocations]);

  const handleLocateMe = useCallback(() => {
    // Prefer fresh device location; fall back to last known tracked location.
    const recenter = (lat: number, lng: number) => {
      setMapCenter([lat, lng]);
    };

    if (isNativePlatform()) {
      Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: isIOSSafari() ? 15000 : 10000,
      })
        .then((pos) => {
          recenter(pos.coords.latitude, pos.coords.longitude);
        })
        .catch(() => {
          if (sortedLocations.length > 0) {
            const last = sortedLocations[sortedLocations.length - 1];
            recenter(last.lat, last.lng);
          }
        });
      return;
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          recenter(position.coords.latitude, position.coords.longitude);
        },
        () => {
          if (sortedLocations.length > 0) {
            const last = sortedLocations[sortedLocations.length - 1];
            recenter(last.lat, last.lng);
          }
        }
      );
    } else if (sortedLocations.length > 0) {
      const last = sortedLocations[sortedLocations.length - 1];
      recenter(last.lat, last.lng);
    }
  }, [sortedLocations]);

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
          updateWhenIdle={true}
          updateWhenZooming={false}
          keepBuffer={4}
        />
        <MapController center={mapCenter} zoom={focusLocation ? 15 : undefined} />
        <ZoomTracker onZoomChange={setZoomLevel} />
        <ViewportTracker onThresholdChange={setViewportThreshold} />
        
        {/* Breadcrumb trail - continuous line connecting all points */}
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

        {/* Friends' latest shared locations */}
        {friendLocations.map((friend) => (
          <Marker
            key={`friend-${friend.friend_id}`}
            position={[friend.latitude, friend.longitude]}
            icon={createFriendIcon(friendColorMap[friend.friend_id] ?? "#22c55e")}
          >
            <Popup>
              <div className="text-sm">
                <p className="font-semibold text-gray-900 dark:text-gray-100">
                  {friend.friend_email}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Last seen at {new Date(friend.timestamp).toLocaleString()}
                </p>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      <button
        type="button"
        onClick={handleLocateMe}
        className="absolute bottom-4 right-4 z-[1000] flex items-center justify-center w-10 h-10 rounded-full bg-white dark:bg-zinc-900 shadow-lg border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-800 transition"
        aria-label="Recenter map to your location"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3" />
          <path d="M12 19v3" />
          <path d="M4 12H2" />
          <path d="M22 12h-2" />
        </svg>
      </button>
      {user && <LocationTracker user={user} onLocationUpdate={onLocationUpdate} onPendingLocationsChange={onPendingLocationsChange} />}
    </div>
  );
}


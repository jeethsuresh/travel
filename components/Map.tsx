"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { fetchImageWithCache } from "@/lib/imageCache";

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

// Check geolocation permission status
const checkPermissionStatus = async (): Promise<PermissionState | null> => {
  if (typeof navigator === "undefined" || !navigator.permissions) {
    return null;
  }
  
  try {
    const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return result.state;
  } catch (error) {
    // Permissions API might not be supported or geolocation might not be queryable
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
  const watchIdRef = useRef<number | null>(null);
  const lastLocationRef = useRef<{ lat: number; lng: number; id: string; timestamp: string } | null>(null);
  const lastSaveTimeRef = useRef<number | null>(null);
  const TRACKING_INTERVAL_MS = 5 * 60 * 1000; // Save location at most once every 5 minutes
  const supabase = createClient();

  // Check permission status on mount
  useEffect(() => {
    checkPermissionStatus().then((status) => {
      setPermissionStatus(status);
    });
  }, []);

  const saveLocation = useCallback(async (lat: number, lng: number) => {
    if (!user) return;

    try {
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

        // If within proximity threshold, update wait_time instead of creating new entry
        if (distance < PROXIMITY_THRESHOLD) {
          const lastTimestamp = new Date(lastLocationRef.current.timestamp);
          const timeDiff = Math.floor((now.getTime() - lastTimestamp.getTime()) / 1000); // seconds

          // Fetch current wait_time and update it
          const { data: currentLocation, error: fetchError } = await supabase
            .from("locations")
            .select("wait_time")
            .eq("id", lastLocationRef.current.id)
            .single();

          if (fetchError) throw fetchError;

          const newWaitTime = (currentLocation?.wait_time || 0) + timeDiff;

          // Update the existing location with new wait_time and timestamp
          const { error: updateError } = await supabase
            .from("locations")
            .update({
              wait_time: newWaitTime,
              timestamp: nowISO, // Update timestamp to reflect last update
            })
            .eq("id", lastLocationRef.current.id)
            .eq("user_id", user.id);

          if (updateError) throw updateError;

          // Update the ref with new timestamp
          lastLocationRef.current = {
            ...lastLocationRef.current,
            lat,
            lng,
            timestamp: nowISO,
          };

          onLocationUpdate();
          return;
        }
      }

      // If not close to last location, create a new entry
      const { data: newLocation, error: insertError } = await supabase
        .from("locations")
        .insert({
          user_id: user.id,
          latitude: lat,
          longitude: lng,
          timestamp: nowISO,
          wait_time: 0, // New location starts with 0 wait time
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Update the ref with the new location
      if (newLocation) {
        lastLocationRef.current = {
          lat: newLocation.latitude,
          lng: newLocation.longitude,
          id: newLocation.id,
          timestamp: newLocation.timestamp,
        };
      }

      onLocationUpdate();
    } catch (error) {
      console.error("Error saving location:", error);
    }
  }, [user, supabase, onLocationUpdate]);

  const startTracking = useCallback(async () => {
    if (!user) {
      setError("Please sign in to track your location");
      return;
    }

    if (!navigator.geolocation) {
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

    // Fetch the last location for this user to compare proximity
    try {
      const { data: lastLocation, error: fetchError } = await supabase
        .from("locations")
        .select("id, latitude, longitude, timestamp")
        .eq("user_id", user.id)
        .order("timestamp", { ascending: false })
        .limit(1)
        .single();

      if (!fetchError && lastLocation) {
        lastLocationRef.current = {
          lat: lastLocation.latitude,
          lng: lastLocation.longitude,
          id: lastLocation.id,
          timestamp: lastLocation.timestamp,
        };
      } else {
        // No previous location or error (which is fine for first time)
        lastLocationRef.current = null;
      }
    } catch (error) {
      // If there's an error fetching, just start fresh
      lastLocationRef.current = null;
    }

    // iOS Safari optimized options
    const geoOptions: PositionOptions = {
      enableHighAccuracy: true,
      maximumAge: isIOSSafari() ? 10000 : 0, // iOS Safari benefits from some caching
      timeout: isIOSSafari() ? 15000 : 10000, // iOS Safari may need more time
    };

    // Request location permission and get initial position
    // This must be called directly from user interaction for iOS Safari
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setCurrentLocation({ lat: latitude, lng: longitude });
        lastSaveTimeRef.current = Date.now();
        saveLocation(latitude, longitude);
        setIsTracking(true);
        setIsRequesting(false);
        setPermissionStatus("granted");

        // Start watching position changes with iOS-optimized options
        const watchOptions: PositionOptions = {
          enableHighAccuracy: true,
          maximumAge: isIOSSafari() ? 5000 : 0,
          timeout: isIOSSafari() ? 15000 : 10000,
        };

        watchIdRef.current = navigator.geolocation.watchPosition(
          (position) => {
            const { latitude, longitude } = position.coords;
            setCurrentLocation({ lat: latitude, lng: longitude });
            const now = Date.now();
            const shouldSave =
              lastSaveTimeRef.current === null ||
              now - lastSaveTimeRef.current >= TRACKING_INTERVAL_MS;
            if (shouldSave) {
              lastSaveTimeRef.current = now;
              saveLocation(latitude, longitude);
            }
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
            if (watchIdRef.current !== null) {
              navigator.geolocation.clearWatch(watchIdRef.current);
              watchIdRef.current = null;
            }
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
  }, [user, supabase, saveLocation]);

  const stopTracking = useCallback(() => {
    setIsTracking(false);
    setError(null);
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    // Reset refs when stopping tracking
    lastLocationRef.current = null;
    lastSaveTimeRef.current = null;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
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

            // If we have storage_path and user, create signed URL and use cache
            if (photo.storage_path && user) {
              // Security check: Ensure storage_path starts with user ID
              if (!photo.storage_path.startsWith(`${user.id}/`)) {
                console.error(`Security: Photo ${photo.id} storage_path doesn't match user ID`);
                setImageUrls((prev) => ({ ...prev, [photo.id]: null }));
                setLoading((prev) => ({ ...prev, [photo.id]: false }));
                return;
              }

              const { data: urlData, error } = await supabase.storage
                .from("photos")
                .createSignedUrl(photo.storage_path, 3600);

              if (error) throw error;
              if (urlData?.signedUrl) {
                // Use cached image if available, otherwise fetch and cache
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

          const { data: urlData, error } = await supabase.storage
            .from("photos")
            .createSignedUrl(photo.storage_path, 3600);

          if (error) throw error;
          if (urlData?.signedUrl) {
            // Use cached image if available, otherwise fetch and cache
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
    locations.forEach((location) => {
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
  }, [photoGroups, locations]);

  // Use visibleLocations for path coordinates (calculated after filtering)
  const pathCoordinates: [number, number][] = useMemo(() => {
    return visibleLocations.map((loc) => [loc.lat, loc.lng]);
  }, [visibleLocations]);

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
      </MapContainer>
      {user && <LocationTracker user={user} onLocationUpdate={onLocationUpdate} />}
    </div>
  );
}


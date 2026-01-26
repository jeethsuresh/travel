"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

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
    html: `<div style="width: ${size}px; height: ${size}px; background-color: ${color}; border-radius: 50%; border: ${borderWidth}px solid white; box-shadow: 0 0 0 ${shadowSize}px rgba(${isFocused ? '245,158,10' : '139,92,246'},${shadowOpacity});"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

interface Location {
  lat: number;
  lng: number;
  timestamp: string;
}

interface Photo {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
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

function LocationTracker({ user, onLocationUpdate }: { user: User | null; onLocationUpdate: () => void }) {
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<PermissionState | null>(null);
  const watchIdRef = useRef<number | null>(null);
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
      const { error } = await supabase.from("locations").insert({
        user_id: user.id,
        latitude: lat,
        longitude: lng,
        timestamp: new Date().toISOString(),
      });

      if (error) throw error;
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
            saveLocation(latitude, longitude);
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
  }, [user, saveLocation]);

  const stopTracking = useCallback(() => {
    setIsTracking(false);
    setError(null);
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
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

function MapController({ center, zoom }: { center: [number, number]; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom || map.getZoom());
  }, [center, zoom, map]);
  return null;
}

export default function Map({ user, locations, photos = [], onLocationUpdate, focusLocation }: MapProps) {
  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]); // Default to London

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

  const pathCoordinates: [number, number][] = locations.map((loc) => [
    loc.lat,
    loc.lng,
  ]);

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
        
        {/* Breadcrumb markers - small dots for each location */}
        {locations.map((location, index) => {
          const isStart = index === 0;
          const isEnd = index === locations.length - 1;
          
          // Use special icons for start and end, breadcrumb dots for the rest
          if (isStart && locations.length > 1) {
            return (
              <Marker
                key={`start-${index}`}
                position={[location.lat, location.lng]}
                icon={createStartIcon()}
              />
            );
          } else if (isEnd && locations.length > 1) {
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
        
        {/* If only one location, show it as a regular marker */}
        {locations.length === 1 && (
          <Marker
            position={[locations[0].lat, locations[0].lng]}
            icon={createBreadcrumbIcon("#3b82f6", 8)}
          />
        )}
        
        {/* Photo location markers - show all photos with location data */}
        {photos.map((photo) => {
          const isFocused = focusLocation && 
            Math.abs(photo.latitude - focusLocation.latitude) < 0.0001 &&
            Math.abs(photo.longitude - focusLocation.longitude) < 0.0001;
          
          return (
            <Marker
              key={`photo-${photo.id}`}
              position={[photo.latitude, photo.longitude]}
              icon={createPhotoIcon(isFocused)}
            />
          );
        })}
      </MapContainer>
      {user && <LocationTracker user={user} onLocationUpdate={onLocationUpdate} />}
    </div>
  );
}


"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import Auth from "@/components/Auth";
import LocationHistory from "@/components/LocationHistory";
import PhotoGallery from "@/components/PhotoGallery";
import type { User } from "@supabase/supabase-js";

// Dynamically import Map component to prevent SSR issues with Leaflet
const Map = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full">Loading map...</div>,
});

interface Location {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
}

interface Photo {
  id: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusLocation, setFocusLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const supabase = createClient();

  useEffect(() => {
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
  }, [supabase.auth]);

  const fetchLocations = useCallback(async () => {
    if (!user) {
      setLocations([]);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("locations")
        .select("*")
        .eq("user_id", user.id)
        .order("timestamp", { ascending: true });

      if (error) throw error;
      setLocations(data || []);
    } catch (error) {
      console.error("Error fetching locations:", error);
    }
  }, [user, supabase]);

  const fetchPhotos = useCallback(async () => {
    if (!user) {
      setPhotos([]);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("photos")
        .select("id, latitude, longitude, timestamp")
        .eq("user_id", user.id)
        .not("latitude", "is", null)
        .not("longitude", "is", null)
        .order("timestamp", { ascending: false });

      if (error) throw error;
      setPhotos((data || []).filter((photo): photo is Photo => 
        photo.latitude !== null && photo.longitude !== null
      ));
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
                  onLocationSelect={(location) => {
                    // Could implement map centering on location select
                    console.log("Selected location:", location);
                  }}
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

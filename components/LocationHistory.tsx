"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { getPendingLocationsForUser } from "@/lib/localStore";

interface Location {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time?: number;
}

interface LocationHistoryProps {
  user: User | null;
  /** When provided, this list is shown (e.g. from parent so new locations appear without refetch). */
  locations?: Location[] | null;
  onLocationSelect?: (location: Location) => void;
  /** Callback to refetch locations (e.g. for Refresh button). */
  onRefresh?: () => void;
}

export default function LocationHistory({
  user,
  locations: locationsProp,
  onLocationSelect,
  onRefresh,
}: LocationHistoryProps) {
  const [locationsState, setLocationsState] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchLocations = useCallback(async () => {
    if (!user) {
      setLocationsState([]);
      setLoading(false);
      return;
    }

    try {
      const [remoteResult, pendingList] = await Promise.all([
        supabase
          .from("locations")
          .select("*")
          .eq("user_id", user.id)
          .order("timestamp", { ascending: false })
          .limit(100),
        getPendingLocationsForUser(user.id),
      ]);

      if (remoteResult.error) throw remoteResult.error;

      const remote = remoteResult.data || [];
      const pendingAsLocations: Location[] = pendingList.map((p) => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: p.timestamp,
        wait_time: p.wait_time,
      }));

      const merged = [...remote, ...pendingAsLocations].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setLocationsState(merged.slice(0, 100));
    } catch (error) {
      console.error("Error fetching locations:", error);
    } finally {
      setLoading(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    if (locationsProp != null) {
      console.log("[Location:LocationHistory] useEffect: using locations from parent", { count: locationsProp.length });
      setLoading(false);
      return;
    }
    console.log("[Location:LocationHistory] useEffect: fetching own locations");
    fetchLocations();
  }, [fetchLocations, locationsProp != null]);

  // Use parent's list when provided so new locations show immediately; otherwise use our fetched list
  const locations =
    locationsProp != null
      ? [...locationsProp].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        ).slice(0, 100)
      : locationsState;

  console.log("[Location:LocationHistory] render", {
    locationsPropNull: locationsProp == null,
    locationsPropLength: locationsProp?.length ?? "n/a",
    locationsStateLength: locationsState.length,
    displayedLocationsLength: locations.length,
  });

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatWaitTime = (seconds: number | undefined) => {
    if (!seconds || seconds === 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  if (!user) {
    return (
      <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
        <p className="text-gray-500 dark:text-gray-400 text-center">
          Please sign in to view your location history
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
        <p className="text-gray-500 dark:text-gray-400 text-center">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          Location History
        </h2>
        <button
          onClick={onRefresh ?? fetchLocations}
          className="px-3 py-1 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
        >
          Refresh
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto space-y-2">
        {locations.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-4">
            No location data yet. Start tracking to see your history!
          </p>
        ) : (
          locations.map((location) => (
            <div
              key={location.id}
              onClick={() => onLocationSelect?.(location)}
              className={`p-3 border border-gray-200 dark:border-gray-700 rounded-md cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors ${
                onLocationSelect ? "cursor-pointer" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm text-gray-900 dark:text-gray-100">
                    {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {formatDate(location.timestamp)}
                  </p>
                  {location.wait_time && location.wait_time > 0 && (
                    <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 font-medium">
                      ⏱️ Waited: {formatWaitTime(location.wait_time)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}


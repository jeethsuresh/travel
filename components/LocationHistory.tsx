"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

interface Location {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time?: number;
}

interface LocationHistoryProps {
  user: User | null;
  onLocationSelect?: (location: Location) => void;
}

export default function LocationHistory({
  user,
  onLocationSelect,
}: LocationHistoryProps) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchLocations = useCallback(async () => {
    if (!user) {
      setLocations([]);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("locations")
        .select("*")
        .eq("user_id", user.id)
        .order("timestamp", { ascending: false })
        .limit(100);

      if (error) throw error;
      setLocations(data || []);
    } catch (error) {
      console.error("Error fetching locations:", error);
    } finally {
      setLoading(false);
    }
  }, [user, supabase]);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

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
          onClick={fetchLocations}
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


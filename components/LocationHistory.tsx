"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/firebase/client";
import { collection, query, where, orderBy, limit, getDocs, Timestamp } from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";
import { getPendingLocationsForUser } from "@/lib/localStore";

interface Location {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time?: number;
}

interface LocationHistoryProps {
  user: FirebaseUser | null;
  /** When provided, this list is shown (e.g. from parent so new locations appear without refetch). */
  locations?: Location[] | null;
  onLocationSelect?: (location: Location) => void;
  /** Callback to refetch locations (e.g. for Refresh button). */
  onRefresh?: () => void;
  /** Whether there are more pages of locations to load. */
  hasMore?: boolean;
  /** Whether an additional page is currently being loaded. */
  isLoadingMore?: boolean;
  /** Called when the user clicks the "Load More" button to load the next page. */
  onLoadMore?: () => void;
}

export default function LocationHistory({
  user,
  locations: locationsProp,
  onLocationSelect,
  onRefresh,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: LocationHistoryProps) {
  const [locationsState, setLocationsState] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const { db } = createClient();

  const fetchLocations = useCallback(async () => {
    if (!user) {
      setLocationsState([]);
      setLoading(false);
      return;
    }

    try {
      const [remoteSnapshot, pendingList] = await Promise.all([
        getDocs(
          query(
            collection(db, "locations"),
            where("user_id", "==", user.uid),
            orderBy("timestamp", "desc"),
            limit(100)
          )
        ),
        getPendingLocationsForUser(user.uid),
      ]);

      const remote: Location[] = remoteSnapshot.docs.map((doc) => {
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
  }, [user, db]);

  useEffect(() => {
    if (locationsProp != null) {
      console.log("[Location:LocationHistory] useEffect: using locations from parent", { count: locationsProp.length });
      setLoading(false);
      setPage(0);
      return;
    }
    console.log("[Location:LocationHistory] useEffect: fetching own locations");
    fetchLocations();
    setPage(0);
  }, [fetchLocations, locationsProp != null]);

  // Use parent's list when provided so new locations show immediately; otherwise use our fetched list.
  // We always paginate locally so that at most 10 items are rendered at once.
  const allLocations =
    locationsProp != null
      ? [...locationsProp].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
      : locationsState;

  const PAGE_SIZE = 10;
  const startIndex = page * PAGE_SIZE;
  const endIndex = startIndex + PAGE_SIZE;
  const locations = allLocations.slice(startIndex, endIndex);

  console.log("[Location:LocationHistory] render", {
    locationsPropNull: locationsProp == null,
    locationsPropLength: locationsProp?.length ?? "n/a",
    locationsStateLength: locationsState.length,
    displayedLocationsLength: locations.length,
  });

  const canShowMoreLocally = endIndex < allLocations.length;

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
      {(hasMore || canShowMoreLocally) && (
        <div className="mt-4 text-center">
          <button
            onClick={() => {
              const nextPage = page + 1;
              if (nextPage * PAGE_SIZE <= allLocations.length) {
                setPage(nextPage);
              } else if (onLoadMore) {
                setPage(nextPage);
                onLoadMore();
              }
            }}
            disabled={isLoadingMore}
            className="px-4 py-2 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoadingMore ? "Loading more..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}


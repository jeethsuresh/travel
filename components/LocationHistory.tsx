"use client";

import { useEffect, useState, useCallback } from "react";
import type { User } from "@/lib/types";
import { getFirebaseFirestore } from "@/lib/firebase";
import { collection, query, where, orderBy, limit, getDocs, Timestamp } from "firebase/firestore";
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
  /** Whether more pages can be loaded from the server. */
  hasMore?: boolean;
  /** True while the next page is loading. */
  loadingMore?: boolean;
  /** Load next page (cursor-based); only used when locations are provided by parent. */
  onLoadMore?: () => void;
  onLocationSelect?: (location: Location) => void;
  /** Callback to refetch locations (e.g. for Refresh button). */
  onRefresh?: () => void;
}

export default function LocationHistory({
  user,
  locations: locationsProp,
  hasMore,
  loadingMore,
  onLoadMore,
  onLocationSelect,
  onRefresh,
}: LocationHistoryProps) {
  const [locationsState, setLocationsState] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  const fetchLocations = useCallback(async () => {
    if (!user) {
      setLocationsState([]);
      setLoading(false);
      return;
    }
    const db = getFirebaseFirestore();
    try {
      const [remoteSnapshot, pendingList] = await Promise.all([
        db
          ? getDocs(
              query(
                collection(db, "locations"),
                where("user_id", "==", user.id),
                orderBy("timestamp", "desc"),
                limit(100)
              )
            )
          : Promise.resolve(null),
        getPendingLocationsForUser(user.id),
      ]);

      const remote: Location[] = [];
      if (remoteSnapshot && !remoteSnapshot.empty) {
        remoteSnapshot.docs.forEach((doc) => {
          const data = doc.data();
          remote.push({
            id: doc.id,
            latitude: data.latitude ?? 0,
            longitude: data.longitude ?? 0,
            timestamp: data.timestamp instanceof Timestamp
              ? data.timestamp.toDate().toISOString()
              : String(data.timestamp ?? ""),
            wait_time: data.wait_time,
          });
        });
      }
      const pendingAsLocations: Location[] = pendingList.map((p) => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: p.timestamp,
        wait_time: p.wait_time,
      }));
      const list = [...remote, ...pendingAsLocations].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setLocationsState(list.slice(0, 100));
    } catch (error) {
      console.error("Error fetching locations:", error);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (locationsProp != null) {
      setLoading(false);
      setPage(0);
      return;
    }
    fetchLocations();
    setPage(0);
  }, [fetchLocations, locationsProp != null]);

  const PAGE_SIZE = 10;
  const allLocations =
    locationsProp != null
      ? [...locationsProp].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
      : locationsState;
  const startIndex = page * PAGE_SIZE;
  const endIndex = startIndex + PAGE_SIZE;
  const locations = allLocations.slice(startIndex, endIndex);
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
          <>
            {locations.map((location) => (
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
            ))}
            {(locationsProp != null && hasMore && onLoadMore) || canShowMoreLocally ? (
              <div className="pt-2 flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    const nextPage = page + 1;
                    if (nextPage * PAGE_SIZE <= allLocations.length) {
                      setPage(nextPage);
                    } else if (onLoadMore) {
                      setPage(nextPage);
                      onLoadMore();
                    }
                  }}
                  disabled={loadingMore}
                  className="px-4 py-2 text-sm bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 rounded-md hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}


"use client";

import { useEffect, useState, useCallback } from "react";
import {
  updateTrip,
  deleteTrip,
  getLocationsForTrip,
  getPhotosForTrip,
  removeTripFromLocation,
  removeTripFromPhoto,
  addTripToLocation,
  addTripToPhoto,
  type Trip,
} from "@/lib/firebase/trips";
import type { User } from "@/lib/types";
import { getFirebaseFirestore } from "@/lib/firebase";
import { collection, query, where, orderBy, limit, getDocs } from "firebase/firestore";
import { getPendingLocationsForUser, getPendingPhotosForUser, updatePendingLocation } from "@/lib/localStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface TripDetailViewProps {
  user: User;
  trip: Trip;
  onClose: () => void;
  onTripDeleted: () => void;
  onTripUpdated?: () => void;
}

interface LocationItem {
  id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  isPending?: boolean;
}

interface PhotoItem {
  id: string;
  timestamp: string;
  isPending?: boolean;
}

export default function TripDetailView({
  user,
  trip,
  onClose,
  onTripDeleted,
  onTripUpdated,
}: TripDetailViewProps) {
  const [name, setName] = useState(trip.name);
  const [startDate, setStartDate] = useState(trip.start_date.split("T")[0]);
  const [endDate, setEndDate] = useState(trip.end_date.split("T")[0]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [allLocations, setAllLocations] = useState<LocationItem[]>([]);
  const [allPhotos, setAllPhotos] = useState<PhotoItem[]>([]);
  const [showAddLocation, setShowAddLocation] = useState(false);
  const [showAddPhoto, setShowAddPhoto] = useState(false);

  const fetchAllLocations = useCallback(async (): Promise<LocationItem[]> => {
    const db = getFirebaseFirestore();
    if (!db) return [];

    try {
      const [remoteSnapshot, pendingList] = await Promise.all([
        getDocs(
          query(
            collection(db, "locations"),
            where("user_id", "==", user.id),
            orderBy("timestamp", "desc"),
            limit(500)
          )
        ),
        getPendingLocationsForUser(user.id),
      ]);

      const remote: LocationItem[] = [];
      if (remoteSnapshot && !remoteSnapshot.empty) {
        remoteSnapshot.docs.forEach((doc) => {
          const data = doc.data();
          remote.push({
            id: doc.id,
            latitude: data.latitude ?? 0,
            longitude: data.longitude ?? 0,
            timestamp: String(data.timestamp ?? ""),
            isPending: false,
          });
        });
      }

      const pending: LocationItem[] = pendingList.map((loc) => ({
        id: loc.id,
        latitude: loc.latitude,
        longitude: loc.longitude,
        timestamp: loc.timestamp,
        isPending: true,
      }));

      return [...remote, ...pending];
    } catch (error) {
      console.error("[TripDetailView] Error fetching all locations:", error);
      return [];
    }
  }, [user.id]);

  const fetchAllPhotos = useCallback(async (): Promise<PhotoItem[]> => {
    try {
      const pendingList = await getPendingPhotosForUser(user.id);
      return pendingList.map((photo) => ({
        id: photo.id,
        timestamp: photo.timestamp,
        isPending: true,
      }));
    } catch (error) {
      console.error("[TripDetailView] Error fetching all photos:", error);
      return [];
    }
  }, [user.id]);

  const fetchTripData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const db = getFirebaseFirestore();
      if (!db) {
        console.warn("[TripDetailView] Firestore not available");
        setLoading(false);
        return;
      }

      const [tripLocations, tripPhotos, allLocs, allPhots] = await Promise.all([
        getLocationsForTrip(user.id, trip.id),
        getPhotosForTrip(user.id, trip.id),
        fetchAllLocations(),
        fetchAllPhotos(),
      ]);

      setLocations(tripLocations.map((loc) => ({ ...loc, isPending: false })));
      setPhotos(tripPhotos.map((photo) => ({ ...photo, isPending: false })));

      // Also include pending locations/photos that have this trip_id
      const pendingLocs = await getPendingLocationsForUser(user.id);
      const pendingPhots = await getPendingPhotosForUser(user.id);

      const pendingLocationsWithTrip = pendingLocs
        .filter((loc) => loc.trip_ids?.includes(trip.id))
        .map((loc) => ({
          id: loc.id,
          latitude: loc.latitude,
          longitude: loc.longitude,
          timestamp: loc.timestamp,
          isPending: true,
        }));

      const pendingPhotosWithTrip = pendingPhots
        .filter((photo) => photo.trip_ids?.includes(trip.id))
        .map((photo) => ({
          id: photo.id,
          timestamp: photo.timestamp,
          isPending: true,
        }));

      setLocations((prev) => [...prev, ...pendingLocationsWithTrip]);
      setPhotos((prev) => [...prev, ...pendingPhotosWithTrip]);

      setAllLocations(allLocs);
      setAllPhotos(allPhots);
    } catch (error) {
      console.error("[TripDetailView] Error fetching trip data:", error);
      setLoading(false);
    } finally {
      setLoading(false);
    }
  }, [user?.id, trip.id, fetchAllLocations, fetchAllPhotos]);

  useEffect(() => {
    fetchTripData().catch((error) => {
      console.error("[TripDetailView] Error in fetchTripData:", error);
      setLoading(false);
    });
  }, [fetchTripData]);

  const handleSave = async () => {
    if (!name.trim()) {
      alert("Trip name is required.");
      return;
    }
    if (!startDate || !endDate) {
      alert("Both start and end dates are required.");
      return;
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end < start) {
      alert("End date must be after start date.");
      return;
    }

    setSaving(true);
    try {
      await updateTrip(trip.id, {
        name: name.trim(),
        start_date: startDate,
        end_date: endDate,
      });
      onTripUpdated?.();
    } catch (error) {
      console.error("[TripDetailView] Error updating trip:", error);
      alert("Failed to update trip.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete "${trip.name}"? This will not remove the locations or photos, only the trip association.`)) {
      return;
    }

    setDeleting(true);
    try {
      await deleteTrip(trip.id);
      onTripDeleted();
    } catch (error) {
      console.error("[TripDetailView] Error deleting trip:", error);
      alert("Failed to delete trip.");
    } finally {
      setDeleting(false);
    }
  };

  const handleRemoveLocation = async (locationId: string, isPending: boolean) => {
    try {
      if (isPending) {
        // For pending locations, update the local store
        const pendingLocs = await getPendingLocationsForUser(user.id);
        const loc = pendingLocs.find((l) => l.id === locationId);
        if (loc) {
          const updatedTripIds = (loc.trip_ids || []).filter((id) => id !== trip.id);
          await updatePendingLocation(locationId, {
            trip_ids: updatedTripIds.length > 0 ? updatedTripIds : undefined,
          });
        }
      } else {
        await removeTripFromLocation(locationId, trip.id);
      }
      setLocations((prev) => prev.filter((loc) => loc.id !== locationId));
    } catch (error) {
      console.error("[TripDetailView] Error removing location:", error);
      alert("Failed to remove location from trip.");
    }
  };

  const handleRemovePhoto = async (photoId: string, isPending: boolean) => {
    try {
      if (isPending) {
        // Similar to locations, handle pending photos
        // For now, just remove from Firestore if it exists
      } else {
        await removeTripFromPhoto(photoId, trip.id);
      }
      setPhotos((prev) => prev.filter((photo) => photo.id !== photoId));
    } catch (error) {
      console.error("[TripDetailView] Error removing photo:", error);
      alert("Failed to remove photo from trip.");
    }
  };

  const handleAddLocation = async (locationId: string) => {
    try {
      const location = allLocations.find((loc) => loc.id === locationId);
      if (!location) return;

      if (location.isPending) {
        // Update pending location's trip_ids
        const pendingLocs = await getPendingLocationsForUser(user.id);
        const loc = pendingLocs.find((l) => l.id === locationId);
        if (loc) {
          const updatedTripIds = [...(loc.trip_ids || []), trip.id];
          await updatePendingLocation(locationId, {
            trip_ids: updatedTripIds,
          });
          setLocations((prev) => [...prev, { ...location, isPending: true }]);
        }
      } else {
        await addTripToLocation(locationId, trip.id);
        setLocations((prev) => [...prev, { ...location, isPending: false }]);
      }
      setShowAddLocation(false);
    } catch (error) {
      console.error("[TripDetailView] Error adding location:", error);
      alert("Failed to add location to trip.");
    }
  };

  const handleAddPhoto = async (photoId: string) => {
    try {
      const photo = allPhotos.find((p) => p.id === photoId);
      if (!photo) return;

      if (photo.isPending) {
        // Similar handling for pending photos
        setPhotos((prev) => [...prev, { ...photo, isPending: true }]);
      } else {
        await addTripToPhoto(photoId, trip.id);
        setPhotos((prev) => [...prev, { ...photo, isPending: false }]);
      }
      setShowAddPhoto(false);
    } catch (error) {
      console.error("[TripDetailView] Error adding photo:", error);
      alert("Failed to add photo to trip.");
    }
  };

  const formatTimestamp = (timestamp: string): string => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp;
    }
  };

  const availableLocations = allLocations.filter(
    (loc) => !locations.some((l) => l.id === loc.id)
  );
  const availablePhotos = allPhotos.filter(
    (photo) => !photos.some((p) => p.id === photo.id)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Trip Details</h2>
        <Button variant="outline" size="sm" onClick={onClose}>
          Back
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Trip Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="detail-name">Trip name</Label>
            <Input
              id="detail-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label htmlFor="detail-start-date">Start date</Label>
              <Input
                id="detail-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="detail-end-date">End date</Label>
              <Input
                id="detail-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving} className="flex-1">
              {saving ? "Saving…" : "Save Changes"}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete Trip"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Locations ({locations.length})</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddLocation(!showAddLocation)}
            >
              {showAddLocation ? "Cancel" : "Add Location"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {showAddLocation && availableLocations.length > 0 && (
            <div className="border border-border rounded-lg p-2 space-y-1 max-h-40 overflow-y-auto">
              {availableLocations.slice(0, 20).map((loc) => (
                <div
                  key={loc.id}
                  className="flex items-center justify-between p-2 hover:bg-accent rounded cursor-pointer"
                  onClick={() => handleAddLocation(loc.id)}
                >
                  <div className="text-sm">
                    {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                    <span className="text-xs text-muted-foreground ml-2">
                      {formatTimestamp(loc.timestamp)}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost">
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
          {locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No locations in this trip.</p>
          ) : (
            locations.map((loc) => (
              <div
                key={loc.id}
                className="flex items-center justify-between rounded-lg border border-border p-2"
              >
                <div className="text-sm">
                  {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                  <span className="text-xs text-muted-foreground ml-2">
                    {formatTimestamp(loc.timestamp)}
                    {loc.isPending && " (pending)"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRemoveLocation(loc.id, loc.isPending ?? false)}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Photos ({photos.length})</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddPhoto(!showAddPhoto)}
            >
              {showAddPhoto ? "Cancel" : "Add Photo"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {showAddPhoto && availablePhotos.length > 0 && (
            <div className="border border-border rounded-lg p-2 space-y-1 max-h-40 overflow-y-auto">
              {availablePhotos.slice(0, 20).map((photo) => (
                <div
                  key={photo.id}
                  className="flex items-center justify-between p-2 hover:bg-accent rounded cursor-pointer"
                  onClick={() => handleAddPhoto(photo.id)}
                >
                  <div className="text-sm">
                    Photo {photo.id.slice(0, 8)}
                    <span className="text-xs text-muted-foreground ml-2">
                      {formatTimestamp(photo.timestamp)}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost">
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
          {photos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No photos in this trip.</p>
          ) : (
            photos.map((photo) => (
              <div
                key={photo.id}
                className="flex items-center justify-between rounded-lg border border-border p-2"
              >
                <div className="text-sm">
                  Photo {photo.id.slice(0, 8)}
                  <span className="text-xs text-muted-foreground ml-2">
                    {formatTimestamp(photo.timestamp)}
                    {photo.isPending && " (pending)"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRemovePhoto(photo.id, photo.isPending ?? false)}
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

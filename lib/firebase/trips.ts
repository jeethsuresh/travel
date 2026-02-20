/**
 * Firestore trips collection: manages trips that group locations and photos.
 */

import type { Firestore } from "firebase/firestore";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseFirestore } from "@/lib/firebase";

const TRIPS_COLLECTION = "trips";
const LOCATIONS_COLLECTION = "locations";
const PHOTOS_COLLECTION = "photos";

export interface Trip {
  id: string;
  user_id: string;
  name: string;
  start_date: string; // ISO date string
  end_date: string; // ISO date string
  is_active: boolean;
  created_at: string;
}

/** Create a new trip. */
export async function createTrip(
  userId: string,
  data: {
    name: string;
    start_date: string;
    end_date: string;
  }
): Promise<Trip> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const tripData = {
    user_id: userId,
    name: data.name.trim(),
    start_date: data.start_date,
    end_date: data.end_date,
    is_active: false,
    created_at: new Date().toISOString(),
  };

  const ref = doc(collection(db, TRIPS_COLLECTION));
  await setDoc(ref, tripData);

  return {
    id: ref.id,
    ...tripData,
  };
}

/** Get all trips for a user. */
export async function getTrips(userId: string): Promise<Trip[]> {
  const db = getFirebaseFirestore();
  if (!db) return [];

  const q = query(collection(db, TRIPS_COLLECTION), where("user_id", "==", userId));
  const snapshot = await getDocs(q);
  const trips = snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      user_id: data.user_id as string,
      name: data.name as string,
      start_date: data.start_date as string,
      end_date: data.end_date as string,
      is_active: (data.is_active as boolean) ?? false,
      created_at: data.created_at as string,
    };
  });

  // Sort by created_at descending (newest first)
  trips.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return trips;
}

/** Subscribe to trips for a user (real-time updates). */
export function subscribeTrips(userId: string, callback: (trips: Trip[]) => void): Unsubscribe {
  const db = getFirebaseFirestore();
  if (!db) {
    callback([]);
    return () => {};
  }

  const q = query(collection(db, TRIPS_COLLECTION), where("user_id", "==", userId));
  return onSnapshot(
    q,
    (snapshot) => {
      const trips = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          user_id: data.user_id as string,
          name: data.name as string,
          start_date: data.start_date as string,
          end_date: data.end_date as string,
          is_active: (data.is_active as boolean) ?? false,
          created_at: data.created_at as string,
        };
      });
      trips.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      callback(trips);
    },
    (error) => {
      console.error("[Trips] Subscription error:", error);
      callback([]);
    }
  );
}

/** Update a trip. */
export async function updateTrip(
  tripId: string,
  updates: Partial<Pick<Trip, "name" | "start_date" | "end_date" | "is_active">>
): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const ref = doc(db, TRIPS_COLLECTION, tripId);
  const updateData: Record<string, unknown> = {};
  if (updates.name !== undefined) updateData.name = updates.name.trim();
  if (updates.start_date !== undefined) updateData.start_date = updates.start_date;
  if (updates.end_date !== undefined) updateData.end_date = updates.end_date;
  if (updates.is_active !== undefined) updateData.is_active = updates.is_active;

  await updateDoc(ref, updateData);
}

/** Delete a trip. */
export async function deleteTrip(tripId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const ref = doc(db, TRIPS_COLLECTION, tripId);
  await deleteDoc(ref);
}

/** Add a trip ID to a location document. */
export async function addTripToLocation(locationId: string, tripId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const ref = doc(db, LOCATIONS_COLLECTION, locationId);
  await updateDoc(ref, {
    trip_ids: arrayUnion(tripId),
  });
}

/** Remove a trip ID from a location document. */
export async function removeTripFromLocation(locationId: string, tripId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const ref = doc(db, LOCATIONS_COLLECTION, locationId);
  await updateDoc(ref, {
    trip_ids: arrayRemove(tripId),
  });
}

/** Add a trip ID to a photo document. */
export async function addTripToPhoto(photoId: string, tripId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const ref = doc(db, PHOTOS_COLLECTION, photoId);
  await updateDoc(ref, {
    trip_ids: arrayUnion(tripId),
  });
}

/** Remove a trip ID from a photo document. */
export async function removeTripFromPhoto(photoId: string, tripId: string): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) throw new Error("Firestore not available");

  const ref = doc(db, PHOTOS_COLLECTION, photoId);
  await updateDoc(ref, {
    trip_ids: arrayRemove(tripId),
  });
}

/** Get all locations for a trip. */
export async function getLocationsForTrip(userId: string, tripId: string): Promise<Array<{ id: string; latitude: number; longitude: number; timestamp: string }>> {
  const db = getFirebaseFirestore();
  if (!db) return [];

  const q = query(
    collection(db, LOCATIONS_COLLECTION),
    where("user_id", "==", userId),
    where("trip_ids", "array-contains", tripId)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      latitude: data.latitude as number,
      longitude: data.longitude as number,
      timestamp: data.timestamp as string,
    };
  });
}

/** Get all photos for a trip. */
export async function getPhotosForTrip(userId: string, tripId: string): Promise<Array<{ id: string; timestamp: string }>> {
  const db = getFirebaseFirestore();
  if (!db) return [];

  const q = query(
    collection(db, PHOTOS_COLLECTION),
    where("user_id", "==", userId),
    where("trip_ids", "array-contains", tripId)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      timestamp: data.timestamp as string,
    };
  });
}

/** Get active trips for a user (is_active === true OR current date is within date range). */
export async function getActiveTrips(userId: string): Promise<Trip[]> {
  const db = getFirebaseFirestore();
  if (!db) return [];

  const allTrips = await getTrips(userId);
  const now = new Date();
  const nowTime = now.getTime();

  return allTrips.filter((trip) => {
    if (trip.is_active) return true;
    const startDate = new Date(trip.start_date);
    const endDate = new Date(trip.end_date);
    return nowTime >= startDate.getTime() && nowTime <= endDate.getTime();
  });
}

/** Check if a timestamp falls within any trip's date range. */
export function getTripsForTimestamp(trips: Trip[], timestamp: string): Trip[] {
  const timestampDate = new Date(timestamp);
  const timestampTime = timestampDate.getTime();

  return trips.filter((trip) => {
    if (trip.is_active) return true;
    const startDate = new Date(trip.start_date);
    const endDate = new Date(trip.end_date);
    return timestampTime >= startDate.getTime() && timestampTime <= endDate.getTime();
  });
}

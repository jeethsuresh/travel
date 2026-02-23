/**
 * Firestore locations collection: upload location data immediately.
 * Locations are saved to IndexedDB first, then uploaded to Firestore in the background.
 */

import type { Firestore } from "firebase/firestore";
import {
  collection,
  doc,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import type { PendingLocation } from "@/lib/localStore";

export interface LocationData {
  user_id: string;
  latitude: number;
  longitude: number;
  timestamp: string | Timestamp;
  wait_time: number;
  trip_ids?: string[];
  created_at?: string | Timestamp;
}

/**
 * Safely convert a timestamp string to a Firestore Timestamp.
 * Returns null if the timestamp is invalid.
 */
function safeTimestampFromString(timestampStr: string | undefined | null): Timestamp | null {
  if (!timestampStr) return null;
  const date = new Date(timestampStr);
  if (isNaN(date.getTime())) {
    console.warn("[Location:upload] Invalid timestamp string:", timestampStr);
    return null;
  }
  return Timestamp.fromDate(date);
}

/**
 * Upload a location to Firestore immediately (non-blocking).
 * This is called after saving to IndexedDB, so failures are acceptable.
 */
export async function uploadLocationToFirestore(
  db: Firestore,
  location: PendingLocation
): Promise<void> {
  try {
    const ref = doc(db, "locations", location.id);
    
    // Convert timestamp string to Firestore Timestamp
    const timestamp = safeTimestampFromString(location.timestamp);
    if (!timestamp) {
      console.error("[Location:upload] Invalid timestamp, skipping upload", { id: location.id, timestamp: location.timestamp });
      return;
    }
    
    const createdAt = location.created_at 
      ? (safeTimestampFromString(location.created_at) ?? Timestamp.now())
      : Timestamp.now();
    
    const data: LocationData = {
      user_id: location.user_id,
      latitude: location.latitude,
      longitude: location.longitude,
      timestamp,
      wait_time: location.wait_time ?? 0,
      created_at: createdAt,
    };
    
    if (location.trip_ids && location.trip_ids.length > 0) {
      data.trip_ids = location.trip_ids;
    }
    
    await setDoc(ref, data, { merge: true });
    console.log("[Location:upload] Successfully uploaded location to Firestore", { id: location.id });
  } catch (error) {
    // Log error but don't throw - location is already saved to IndexedDB
    console.error("[Location:upload] Failed to upload location to Firestore", { 
      id: location.id, 
      error 
    });
  }
}

/**
 * Update an existing location in Firestore (for wait_time updates).
 */
export async function updateLocationInFirestore(
  db: Firestore,
  locationId: string,
  updates: {
    latitude?: number;
    longitude?: number;
    timestamp?: string;
    wait_time?: number;
    trip_ids?: string[];
  }
): Promise<void> {
  try {
    const ref = doc(db, "locations", locationId);
    const updateData: Partial<LocationData> = {};
    
    if (updates.latitude !== undefined) {
      updateData.latitude = updates.latitude;
    }
    if (updates.longitude !== undefined) {
      updateData.longitude = updates.longitude;
    }
    if (updates.timestamp !== undefined) {
      const timestamp = safeTimestampFromString(updates.timestamp);
      if (!timestamp) {
        console.error("[Location:upload] Invalid timestamp in update, skipping", { id: locationId, timestamp: updates.timestamp });
        return;
      }
      updateData.timestamp = timestamp;
    }
    if (updates.wait_time !== undefined) {
      updateData.wait_time = updates.wait_time;
    }
    if (updates.trip_ids !== undefined) {
      updateData.trip_ids = updates.trip_ids;
    }
    
    await setDoc(ref, updateData, { merge: true });
    console.log("[Location:upload] Successfully updated location in Firestore", { id: locationId });
  } catch (error) {
    // Log error but don't throw - location is already saved to IndexedDB
    console.error("[Location:upload] Failed to update location in Firestore", { 
      id: locationId, 
      error 
    });
  }
}

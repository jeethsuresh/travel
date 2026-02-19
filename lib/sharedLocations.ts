"use client";

import {
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseFirestore } from "@/lib/firebase";
import { getFriends } from "@/lib/friends";

const COLLECTION = "shared_locations";

export interface SharedLocationEntry {
  user_id: string;
  display_name: string;
  lat: number;
  lng: number;
  timestamp: string;
  wait_time?: number;
  shared_with: string[];
}

/** Get list of friend IDs we are sharing our location with (for writing shared_locations). */
export async function getFriendIdsWeShareWith(userId: string): Promise<string[]> {
  const friends = await getFriends(userId);
  return friends
    .filter((f) => f.share_location_with_friend)
    .map((f) => f.friend_id);
}

/** Write or update our shared_locations doc so friends in shared_with can see our last location. */
export async function updateMySharedLocation(
  userId: string,
  displayName: string,
  lat: number,
  lng: number,
  timestamp: string,
  waitTime?: number
): Promise<void> {
  const db = getFirebaseFirestore();
  if (!db) return;
  const sharedWith = await getFriendIdsWeShareWith(userId);
  if (sharedWith.length === 0) {
    // Optional: delete doc if we no longer share with anyone
    return;
  }
  const ref = doc(db, COLLECTION, userId);
  await setDoc(ref, {
    user_id: userId,
    display_name: displayName || "",
    lat,
    lng,
    timestamp,
    wait_time: waitTime ?? 0,
    shared_with: sharedWith,
  });
}

export interface FriendLocation {
  user_id: string;
  display_name: string;
  lat: number;
  lng: number;
  timestamp: string;
  wait_time?: number;
}

/** Subscribe to shared locations that are shared with the current user. */
export function subscribeSharedLocationsForUser(
  myUserId: string,
  onLocations: (locations: FriendLocation[]) => void
): Unsubscribe {
  const db = getFirebaseFirestore();
  if (!db) {
    onLocations([]);
    return () => {};
  }
  const q = query(
    collection(db, COLLECTION),
    where("shared_with", "array-contains", myUserId)
  );
  return onSnapshot(
    q,
    (snap) => {
      const locations: FriendLocation[] = [];
      for (const d of snap.docs) {
        const data = d.data();
        const lat = Number(data.lat);
        const lng = Number(data.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
        locations.push({
          user_id: data.user_id ?? "",
          display_name: typeof data.display_name === "string" ? data.display_name : "",
          lat,
          lng,
          timestamp: data.timestamp ?? "",
          wait_time: data.wait_time,
        });
      }
      onLocations(locations);
    },
    () => onLocations([])
  );
}

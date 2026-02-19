/**
 * Firestore photos collection: metadata only (no image bytes).
 * Stores local_name so image locations persist across app resets; images live in local storage only.
 */

import type { Firestore } from "firebase/firestore";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  query,
  where,
  getDocs,
} from "firebase/firestore";

export interface PhotoMetadata {
  id: string;
  user_id: string;
  /** Local storage key (IndexedDB id / iOS path base) so we can match after reset */
  local_name: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  created_at: string;
}

/** Persist photo metadata to Firestore (doc id = photo id for easy delete/merge). */
export async function addPhotoMetadata(
  db: Firestore,
  userId: string,
  data: {
    id: string;
    local_name: string;
    latitude: number | null;
    longitude: number | null;
    timestamp: string;
    created_at: string;
  }
): Promise<void> {
  const ref = doc(db, "photos", data.id);
  await setDoc(ref, {
    user_id: userId,
    local_name: data.local_name,
    latitude: data.latitude,
    longitude: data.longitude,
    timestamp: data.timestamp,
    created_at: data.created_at,
  });
}

/** Remove photo metadata from Firestore. */
export async function deletePhotoMetadata(db: Firestore, photoId: string): Promise<void> {
  const ref = doc(db, "photos", photoId);
  await deleteDoc(ref);
}

/** Fetch all photo metadata for a user (for merge with local after reset). */
export async function getPhotoMetadataForUser(db: Firestore, userId: string): Promise<PhotoMetadata[]> {
  const q = query(collection(db, "photos"), where("user_id", "==", userId));
  const snapshot = await getDocs(q);
  const list = snapshot.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      user_id: x.user_id as string,
      local_name: (x.local_name as string) ?? d.id,
      latitude: x.latitude ?? null,
      longitude: x.longitude ?? null,
      timestamp: x.timestamp ?? "",
      created_at: x.created_at ?? "",
    };
  });
  list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return list;
}

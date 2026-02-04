/**
 * Local-first storage: IndexedDB for locations queue, photos (with blobs), and timeline cache.
 * Data is written locally first and synced to Supabase in the background.
 */

const DB_NAME = "travel_local";
const DB_VERSION = 1;
const STORE_LOCATIONS = "pending_locations";
const STORE_PHOTOS = "pending_photos";
const STORE_TIMELINE = "timeline_cache";

export interface PendingLocation {
  id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time: number;
  created_at: string;
}

export interface PendingPhoto {
  id: string;
  user_id: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  blob: Blob;
  created_at: string;
}

export interface TimelineCacheEntry {
  connections: Array<{ from: [number, number]; to: [number, number] }>;
  pathCoordinates: [number, number][];
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("IndexedDB only available in browser"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_LOCATIONS)) {
        db.createObjectStore(STORE_LOCATIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        db.createObjectStore(STORE_PHOTOS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_TIMELINE)) {
        db.createObjectStore(STORE_TIMELINE, { keyPath: "key" });
      }
    };
  });
}

function generateLocalId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// --- Pending locations ---

export async function addPendingLocation(
  loc: Omit<PendingLocation, "id" | "created_at">
): Promise<PendingLocation> {
  console.log("[Location:localStore] addPendingLocation entry", { lat: loc.latitude, lng: loc.longitude, userId: loc.user_id });
  const db = await openDB();
  const id = generateLocalId("loc");
  const created_at = new Date().toISOString();
  const record: PendingLocation = {
    id,
    created_at,
    ...loc,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCATIONS, "readwrite");
    const store = tx.objectStore(STORE_LOCATIONS);
    store.put(record);
    tx.oncomplete = () => {
      db.close();
      console.log("[Location:localStore] addPendingLocation done", { id: record.id });
      resolve(record);
    };
    tx.onerror = () => {
      db.close();
      console.log("[Location:localStore] addPendingLocation error", tx.error);
      reject(tx.error);
    };
  });
}

export async function updatePendingLocation(
  id: string,
  updates: Partial<Pick<PendingLocation, "latitude" | "longitude" | "timestamp" | "wait_time">>
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCATIONS, "readwrite");
    const store = tx.objectStore(STORE_LOCATIONS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        db.close();
        reject(new Error("Pending location not found"));
        return;
      }
      store.put({ ...existing, ...updates });
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deletePendingLocation(id: string): Promise<void> {
  console.log("[Location:localStore] deletePendingLocation", { id });
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCATIONS, "readwrite");
    tx.objectStore(STORE_LOCATIONS).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getPendingLocationsForUser(userId: string): Promise<PendingLocation[]> {
  console.log("[Location:localStore] getPendingLocationsForUser entry", { userId });
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCATIONS, "readonly");
    const request = tx.objectStore(STORE_LOCATIONS).getAll();
    tx.oncomplete = () => {
      db.close();
      const all = request.result || [];
      const filtered = all.filter((l: PendingLocation) => l.user_id === userId);
      console.log("[Location:localStore] getPendingLocationsForUser done", { totalInStore: all.length, forUser: filtered.length, ids: filtered.map((l: PendingLocation) => l.id) });
      resolve(filtered);
    };
    tx.onerror = () => {
      db.close();
      console.warn("[Location:localStore] getPendingLocationsForUser error; treating as empty list", tx.error ?? "Unknown IndexedDB error");
      resolve([]);
    };
  });
}

// --- Pending photos ---

export async function addPendingPhoto(
  photo: Omit<PendingPhoto, "id" | "created_at">
): Promise<PendingPhoto> {
  const db = await openDB();
  const id = generateLocalId("photo");
  const created_at = new Date().toISOString();
  const record: PendingPhoto = {
    id,
    created_at,
    ...photo,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readwrite");
    tx.objectStore(STORE_PHOTOS).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve(record);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getPendingPhotosForUser(userId: string): Promise<PendingPhoto[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readonly");
    const request = tx.objectStore(STORE_PHOTOS).getAll();
    tx.oncomplete = () => {
      db.close();
      const all = request.result || [];
      resolve(all.filter((p: PendingPhoto) => p.user_id === userId));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deletePendingPhoto(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, "readwrite");
    tx.objectStore(STORE_PHOTOS).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// --- Timeline cache ---

function timelineCacheKey(userId: string, dataHash: string): string {
  return `${userId}_${dataHash}`;
}

export function hashTimelineInput(
  locations: Array<{ lat: number; lng: number; timestamp: string }>,
  photos: Array<{ id: string; timestamp: string; latitude: number; longitude: number }>
): string {
  const locStr = locations
    .map((l) => `${l.timestamp}-${l.lat}-${l.lng}`)
    .join("|");
  const photoStr = photos
    .map((p) => `${p.id}-${p.timestamp}-${p.latitude}-${p.longitude}`)
    .join("|");
  let h = 0;
  const s = locStr + "#" + photoStr;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

export async function getTimelineCache(
  userId: string,
  dataHash: string
): Promise<TimelineCacheEntry | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TIMELINE, "readonly");
    const request = tx.objectStore(STORE_TIMELINE).get(timelineCacheKey(userId, dataHash));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result?.value ?? null);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function setTimelineCache(
  userId: string,
  dataHash: string,
  value: TimelineCacheEntry
): Promise<void> {
  const db = await openDB();
  const key = timelineCacheKey(userId, dataHash);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TIMELINE, "readwrite");
    tx.objectStore(STORE_TIMELINE).put({ key, value });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

const TIMELINE_STORAGE_PREFIX = "travel_timeline_";

/** Synchronous timeline cache (localStorage) so Map can use it inside useMemo without async. */
export function getTimelineCacheSync(
  userId: string,
  dataHash: string
): TimelineCacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TIMELINE_STORAGE_PREFIX + timelineCacheKey(userId, dataHash));
    if (!raw) return null;
    return JSON.parse(raw) as TimelineCacheEntry;
  } catch {
    return null;
  }
}

export function setTimelineCacheSync(
  userId: string,
  dataHash: string,
  value: TimelineCacheEntry
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      TIMELINE_STORAGE_PREFIX + timelineCacheKey(userId, dataHash),
      JSON.stringify(value)
    );
  } catch (e) {
    console.warn("Timeline cache write failed:", e);
  }
}

/**
 * Local-only photo storage: IndexedDB (web) and optionally Capacitor Filesystem on iOS
 * for opening with @capacitor/file-viewer. No cloud storage.
 */

import { openDB, STORE_LOCAL_PHOTOS } from "@/lib/localStore";
import { isNativePlatform } from "@/lib/capacitor";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { FileViewer } from "@capacitor/file-viewer";

export interface LocalPhotoRecord {
  id: string;
  user_id: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  created_at: string;
  blob: Blob;
  /** On iOS: full file URI for display and FileViewer.openDocumentFromLocalPath */
  localPath?: string;
  /** On iOS: relative path for Filesystem.deleteFile */
  localPathRelative?: string;
}

const PHOTO_PREFIX = "photo_";

function generateId(): string {
  return `${PHOTO_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Save a photo locally. On web: IndexedDB only. On iOS: IndexedDB + write to Filesystem for FileViewer.
 */
export async function addLocalPhoto(
  userId: string,
  blob: Blob,
  metadata: {
    latitude?: number | null;
    longitude?: number | null;
    timestamp?: string;
  }
): Promise<LocalPhotoRecord> {
  const db = await openDB();
  const id = generateId();
  const created_at = new Date().toISOString();
  const timestamp = metadata.timestamp ?? created_at;

  let localPath: string | undefined;
  let localPathRelative: string | undefined;
  if (isNativePlatform() && typeof Capacitor !== "undefined") {
    try {
      const base64 = await blobToBase64(blob);
      const fileName = `${id}.jpg`;
      const relativePath = `travel_photos/${fileName}`;
      const result = await Filesystem.writeFile({
        path: relativePath,
        data: base64,
        directory: Directory.Cache,
      });
      localPath = result.uri;
      localPathRelative = relativePath;
    } catch (e) {
      console.warn("[localPhotoStorage] iOS Filesystem write failed", e);
    }
  }

  const record: LocalPhotoRecord = {
    id,
    user_id: userId,
    latitude: metadata.latitude ?? null,
    longitude: metadata.longitude ?? null,
    timestamp,
    created_at,
    blob,
    ...(localPath && { localPath }),
    ...(localPathRelative && { localPathRelative }),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCAL_PHOTOS, "readwrite");
    tx.objectStore(STORE_LOCAL_PHOTOS).put(record);
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

/**
 * Get all local photos for a user. Returns records with blob; call getLocalPhotoUrl(id) for display URL.
 */
export async function getAllLocalPhotosForUser(userId: string): Promise<LocalPhotoRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCAL_PHOTOS, "readonly");
    const req = tx.objectStore(STORE_LOCAL_PHOTOS).getAll();
    tx.oncomplete = () => {
      db.close();
      const all = (req.result || []) as LocalPhotoRecord[];
      resolve(all.filter((p) => p.user_id === userId));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Get a display URL for a local photo (blob URL or Capacitor file URL). Caller should revoke blob URLs when done if needed.
 */
export async function getLocalPhotoUrl(record: LocalPhotoRecord): Promise<string> {
  if (isNativePlatform() && record.localPath) {
    return Capacitor.convertFileSrc(record.localPath);
  }
  return URL.createObjectURL(record.blob);
}

/**
 * Get a single record by id.
 */
export async function getLocalPhoto(id: string): Promise<LocalPhotoRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCAL_PHOTOS, "readonly");
    const req = tx.objectStore(STORE_LOCAL_PHOTOS).get(id);
    tx.oncomplete = () => {
      db.close();
      resolve((req.result as LocalPhotoRecord) ?? null);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Delete a local photo (IndexedDB and optionally iOS cache file).
 */
export async function deleteLocalPhoto(id: string): Promise<void> {
  const record = await getLocalPhoto(id);
  if (record?.localPathRelative && isNativePlatform()) {
    try {
      await Filesystem.deleteFile({
        path: record.localPathRelative,
        directory: Directory.Cache,
      }).catch(() => {});
    } catch {
      // ignore
    }
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOCAL_PHOTOS, "readwrite");
    tx.objectStore(STORE_LOCAL_PHOTOS).delete(id);
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

/**
 * On iOS: open the photo in the system document viewer (File Viewer plugin).
 * On web: no-op or fallback to opening blob in new tab.
 */
export async function openPhotoInViewer(record: LocalPhotoRecord): Promise<void> {
  if (isNativePlatform() && record.localPath) {
    await FileViewer.openDocumentFromLocalPath({
      path: record.localPath,
    });
    return;
  }
  const url = URL.createObjectURL(record.blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Automatic photo scanning utility: checks device photo library for new photos
 * when app comes to foreground and adds them to the app.
 */

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem } from "@capacitor/filesystem";
import { isNativePlatform } from "@/lib/capacitor";
import { getPendingPhotosForUser, addPendingPhoto } from "@/lib/localStore";
import { compressImage } from "@/lib/imageCompression";
import exifr from "exifr";

// Lazy-load Media plugin to avoid initialization issues on app startup
let Media: any = null;
let mediaLoadAttempted = false;

async function getMediaPlugin() {
  // Only attempt to load once
  if (mediaLoadAttempted) {
    return Media;
  }
  
  mediaLoadAttempted = true;
  
  if (typeof window === "undefined") {
    return null;
  }
  
  try {
    // Ensure Capacitor is available and ready
    if (typeof Capacitor === "undefined") {
      console.warn("[photoScanner] Capacitor not available");
      return null;
    }
    
    // Check if we're on a native platform
    if (!Capacitor.isNativePlatform()) {
      return null;
    }
    
    // Dynamically import the Media plugin
    const mediaModule = await import("@capacitor-community/media");
    Media = mediaModule.Media;
    
    // Verify Media plugin is available
    if (!Media) {
      console.warn("[photoScanner] Media plugin not available after import");
      return null;
    }
    
    return Media;
  } catch (error) {
    console.warn("[photoScanner] Failed to load Media plugin:", error);
    return null;
  }
}

const LAST_PHOTO_SCAN_KEY = "jeethtravel.lastPhotoScanTimestamp";

/**
 * Get the timestamp of the last photo scan
 */
async function getLastPhotoScanTimestamp(): Promise<number> {
  try {
    const { value } = await Preferences.get({ key: LAST_PHOTO_SCAN_KEY });
    if (value) {
      const timestamp = parseInt(value, 10);
      if (!isNaN(timestamp)) {
        return timestamp;
      }
    }
  } catch (e) {
    console.warn("[photoScanner] Failed to get last scan timestamp", e);
  }
  return 0;
}

/**
 * Store the timestamp of the last photo scan
 */
async function setLastPhotoScanTimestamp(timestamp: number): Promise<void> {
  try {
    await Preferences.set({ key: LAST_PHOTO_SCAN_KEY, value: String(timestamp) });
  } catch (e) {
    console.warn("[photoScanner] Failed to set last scan timestamp", e);
  }
}

/**
 * Extract EXIF data from a file (GPS coordinates and timestamp)
 */
async function extractExifData(file: File): Promise<{
  latitude?: number;
  longitude?: number;
  timestamp?: string;
}> {
  try {
    const exifData = await exifr.parse(file, {
      gps: true,
      exif: true,
    });

    const result: { latitude?: number; longitude?: number; timestamp?: string } = {};

    // Extract GPS coordinates
    if (exifData && exifData.latitude && exifData.longitude) {
      result.latitude = exifData.latitude;
      result.longitude = exifData.longitude;
    }

    // Extract date/time when photo was taken
    const dateTimeOriginal = exifData?.DateTimeOriginal || exifData?.DateTime || exifData?.CreateDate;

    if (dateTimeOriginal) {
      let photoDate: Date;

      if (typeof dateTimeOriginal === "string") {
        const dateStr = dateTimeOriginal.replace(/(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
        photoDate = new Date(dateStr);
      } else if (dateTimeOriginal instanceof Date) {
        photoDate = dateTimeOriginal;
      } else {
        photoDate = new Date(dateTimeOriginal);
      }

      if (
        !isNaN(photoDate.getTime()) &&
        photoDate.getTime() <= Date.now() &&
        photoDate.getTime() > new Date("1900-01-01").getTime()
      ) {
        result.timestamp = photoDate.toISOString();
      }
    }

    return result;
  } catch (error) {
    console.log("[photoScanner] Could not extract EXIF data:", error);
  }

  return {};
}

/**
 * Check if a photo already exists in the app by comparing timestamps
 * We consider a photo duplicate if it has the same timestamp (within 1 second tolerance)
 */
async function isPhotoDuplicate(
  userId: string,
  photoTimestamp: string
): Promise<boolean> {
  try {
    const existingPhotos = await getPendingPhotosForUser(userId);
    const photoTime = new Date(photoTimestamp).getTime();

    for (const existing of existingPhotos) {
      const existingTime = new Date(existing.timestamp).getTime();
      // Consider duplicate if timestamps are within 1 second
      if (Math.abs(photoTime - existingTime) < 1000) {
        return true;
      }
    }
  } catch (error) {
    console.warn("[photoScanner] Error checking for duplicates", error);
  }
  return false;
}

/**
 * Convert base64 string to Blob
 */
function base64ToBlob(base64: string, mimeType: string = "image/jpeg"): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

/**
 * Scan for new photos from device library and add them to the app
 * Uses the Media plugin for programmatic access to photos
 */
export async function scanForNewPhotos(userId: string): Promise<number> {
  if (!isNativePlatform()) {
    // Only works on native platforms
    return 0;
  }

  try {
    // Lazy-load Media plugin
    const MediaPlugin = await getMediaPlugin();
    if (!MediaPlugin) {
      console.warn("[photoScanner] Media plugin not available");
      return 0;
    }

    const lastScanTimestamp = await getLastPhotoScanTimestamp();
    const lastScanDate = lastScanTimestamp > 0 ? new Date(lastScanTimestamp) : new Date(0);

    // Get recent photos from device library (last 100 photos, sorted by creation date descending)
    // This will get photos newer than our last scan
    const result = await MediaPlugin.getMedias({
      quantity: 100,
      types: "photos",
      sort: [{ key: "creationDate", ascending: false }],
      thumbnailWidth: 1024, // Get larger thumbnails for better quality
      thumbnailHeight: 1024,
      thumbnailQuality: 90,
    });

    if (!result.medias || result.medias.length === 0) {
      console.log("[photoScanner] No photos found in library");
      return 0;
    }

    const existingPhotos = await getPendingPhotosForUser(userId);
    const existingTimestamps = new Set(
      existingPhotos.map((p) => {
        const time = new Date(p.timestamp).getTime();
        // Round to nearest second for comparison
        return Math.floor(time / 1000);
      })
    );

    // Also track identifiers to avoid duplicates
    const existingIdentifiers = new Set(
      existingPhotos.map((p) => {
        // Try to extract identifier from photo ID if it contains one
        // This is a fallback - we primarily use timestamps
        return p.id;
      })
    );

    let addedCount = 0;

    // Process each photo
    for (const media of result.medias) {
      try {
        const creationDate = new Date(media.creationDate);
        
        // Skip photos older than our last scan (unless this is the first scan)
        if (lastScanTimestamp > 0 && creationDate.getTime() <= lastScanTimestamp) {
          continue;
        }

        // Check if this photo is a duplicate by timestamp
        const timestampSeconds = Math.floor(creationDate.getTime() / 1000);
        if (existingTimestamps.has(timestampSeconds)) {
          console.log("[photoScanner] Skipping duplicate photo by timestamp", media.creationDate);
          continue;
        }

        // Get full-quality image
        let imageBlob: Blob;
        let imageFile: File;

        if (Capacitor.getPlatform() === "ios") {
          // On iOS, get the full-quality image path using the identifier
          const mediaPath = await MediaPlugin.getMediaByIdentifier({
            identifier: media.identifier,
          });
          
          // Read the file using Filesystem plugin
          const fileData = await Filesystem.readFile({
            path: mediaPath.path,
          });

          // Convert base64 to blob
          imageBlob = base64ToBlob(fileData.data as string, "image/jpeg");
        } else {
          // On Android, the identifier IS the path
          // Read the file directly
          const fileData = await Filesystem.readFile({
            path: media.identifier,
          });

          imageBlob = base64ToBlob(fileData.data as string, "image/jpeg");
        }

        imageFile = new File([imageBlob], `photo-${media.identifier}.jpg`, {
          type: "image/jpeg",
        });

        // Extract GPS coordinates from media location if available
        let latitude: number | null = null;
        let longitude: number | null = null;
        if (media.location) {
          latitude = media.location.latitude;
          longitude = media.location.longitude;
        } else {
          // Try to extract from EXIF as fallback
          const exifData = await extractExifData(imageFile);
          if (exifData.latitude && exifData.longitude) {
            latitude = exifData.latitude;
            longitude = exifData.longitude;
          }
        }

        // Use creation date from media, or fallback to EXIF timestamp
        let photoTimestamp = media.creationDate;
        if (!photoTimestamp || photoTimestamp === "Invalid Date") {
          const exifData = await extractExifData(imageFile);
          photoTimestamp = exifData.timestamp ?? new Date().toISOString();
        }

        // Compress the image
        const compressedFile = await compressImage(imageFile);

        // Add to pending photos
        await addPendingPhoto({
          user_id: userId,
          latitude,
          longitude,
          timestamp: photoTimestamp,
          blob: compressedFile,
        });

        addedCount++;
      } catch (error) {
        console.error("[photoScanner] Error processing photo:", error);
        // Continue with next photo
      }
    }

    // Update last scan timestamp
    await setLastPhotoScanTimestamp(Date.now());

    console.log(`[photoScanner] Added ${addedCount} new photos`);
    return addedCount;
  } catch (error) {
    console.error("[photoScanner] Error scanning photos:", error);
    // Check if it's a permission error or other recoverable error
    if (error instanceof Error) {
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes("permission") || errorMsg.includes("denied")) {
        console.warn("[photoScanner] Photo library permission not granted");
      } else if (errorMsg.includes("unimplemented") || errorMsg.includes("not available")) {
        console.warn("[photoScanner] getMedias not available on this platform");
      } else {
        console.error("[photoScanner] Unexpected error:", error);
      }
    } else {
      console.error("[photoScanner] Unknown error:", error);
    }
    // Always return 0 on error to prevent app crash
    return 0;
  }
}

/**
 * Check if we should scan for photos based on last scan time
 * Returns true if we haven't scanned in the last 5 minutes
 */
export async function shouldScanForPhotos(): Promise<boolean> {
  if (!isNativePlatform()) {
    return false;
  }

  try {
    const lastScan = await getLastPhotoScanTimestamp();
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;

    // Scan if we haven't scanned in the last 5 minutes
    return now - lastScan > FIVE_MINUTES;
  } catch (error) {
    console.warn("[photoScanner] Error checking scan interval", error);
    return true; // Default to scanning if we can't check
  }
}

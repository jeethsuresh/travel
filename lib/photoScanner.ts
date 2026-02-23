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

// Media plugin - must be loaded dynamically (synchronous require doesn't work properly)
let Media: any = null;
let mediaLoadAttempted = false;

async function getMediaPlugin() {
  console.log("[photoScanner] getMediaPlugin called", { 
    mediaLoadAttempted, 
    hasMedia: !!Media,
    mediaType: typeof Media,
    mediaKeys: Media ? Object.keys(Media) : [],
    hasGetMedias: Media ? typeof Media.getMedias : "N/A"
  });
  
  // If we already have Media from a previous load, verify it has getMedias
  if (Media && typeof Media.getMedias === "function") {
    console.log("[photoScanner] Using cached Media (has getMedias)");
    return Media;
  }
  
  // Only attempt to load once
  if (mediaLoadAttempted) {
    console.log("[photoScanner] Already attempted, returning cached Media:", !!Media);
    return Media;
  }
  
  mediaLoadAttempted = true;
  console.log("[photoScanner] First time loading, setting mediaLoadAttempted = true");
  
  if (typeof window === "undefined") {
    console.log("[photoScanner] window is undefined, returning null");
    return null;
  }
  
  try {
    // Ensure Capacitor is available and ready
    console.log("[photoScanner] Checking Capacitor...");
    if (typeof Capacitor === "undefined") {
      console.warn("[photoScanner] Capacitor not available");
      return null;
    }
    
    // Check if we're on a native platform
    console.log("[photoScanner] Checking if native platform...");
    if (!Capacitor.isNativePlatform()) {
      console.log("[photoScanner] Not native platform");
      return null;
    }
    
    // Try dynamic import
    console.log("[photoScanner] Dynamically importing @capacitor-community/media...");
    const mediaModule = await import("@capacitor-community/media");
    console.log("[photoScanner] Media module imported:", !!mediaModule);
    console.log("[photoScanner] Media module keys:", Object.keys(mediaModule));
    
    // Try to get Media from the module
    Media = mediaModule.Media || mediaModule.default || mediaModule;
    console.log("[photoScanner] Media assigned:", !!Media, typeof Media);
    
    // If Media is still empty or doesn't have getMedias, try Capacitor registry
    if (!Media || (typeof Media === "object" && Object.keys(Media).length === 0)) {
      console.log("[photoScanner] Media is empty, trying Capacitor.Plugins...");
      if ((window as any).Capacitor?.Plugins?.Media) {
        Media = (window as any).Capacitor.Plugins.Media;
        console.log("[photoScanner] Found Media in Capacitor.Plugins:", !!Media);
      }
    }
    
    // Verify Media plugin is available and has getMedias method
    if (!Media) {
      console.warn("[photoScanner] Media plugin not available after import");
      return null;
    }
    
    console.log("[photoScanner] Media object keys:", Object.keys(Media));
    console.log("[photoScanner] Media.getMedias type:", typeof Media.getMedias);
    
    if (typeof Media.getMedias !== "function") {
      console.error("[photoScanner] Media.getMedias is not a function!");
      console.error("[photoScanner] Media object:", Media);
      throw new Error("Media plugin does not have getMedias method");
    }
    
    // Store Media in module-level cache
    const cachedMedia = Media;
    console.log("[photoScanner] Media plugin loaded successfully, cachedMedia:", !!cachedMedia);
    console.log("[photoScanner] About to return from getMediaPlugin");
    
    // Use setTimeout to ensure promise resolves in next tick (workaround for potential promise resolution issues)
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log("[photoScanner] Resolving promise with Media");
        resolve(cachedMedia);
      }, 0);
    });
  } catch (error) {
    console.error("[photoScanner] Failed to load Media plugin:", error);
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

export interface ScannedPhoto {
  identifier: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  thumbnailUrl?: string;
  // Lazy-loaded full image data (only loaded when adding photos)
  _fullImageBlob?: Blob;
  _fullImageFile?: File;
}

/**
 * Load full image for a scanned photo (lazy loading)
 */
async function loadFullImage(MediaPlugin: any, identifier: string): Promise<{ blob: Blob; file: File }> {
  if (Capacitor.getPlatform() === "ios") {
    // On iOS, get the full-quality image path using the identifier
    const mediaPath = await MediaPlugin.getMediaByIdentifier({
      identifier,
    });
    
    // Read the file using Filesystem plugin
    const fileData = await Filesystem.readFile({
      path: mediaPath.path,
    });

    // Convert base64 to blob
    const blob = base64ToBlob(fileData.data as string, "image/jpeg");
    const file = new File([blob], `photo-${identifier}.jpg`, {
      type: "image/jpeg",
    });
    return { blob, file };
  } else {
    // On Android, the identifier IS the path
    // Read the file directly
    const fileData = await Filesystem.readFile({
      path: identifier,
    });

    const blob = base64ToBlob(fileData.data as string, "image/jpeg");
    const file = new File([blob], `photo-${identifier}.jpg`, {
      type: "image/jpeg",
    });
    return { blob, file };
  }
}

/**
 * Scan for new photos from device library and return them for user selection
 * Uses the Media plugin for programmatic access to photos
 */
export async function scanForNewPhotos(userId: string): Promise<ScannedPhoto[]> {
  console.log("[photoScanner] scanForNewPhotos called", { userId, isNative: isNativePlatform() });
  
  if (!isNativePlatform()) {
    // Only works on native platforms
    console.log("[photoScanner] Not native platform, returning empty array");
    return [];
  }

  console.log("[photoScanner] Starting scan...");
  
  try {
    // Lazy-load Media plugin
    console.log("[photoScanner] Loading Media plugin...");
    let MediaPlugin: any;
    try {
      console.log("[photoScanner] About to await getMediaPlugin()...");
      MediaPlugin = await getMediaPlugin();
      console.log("[photoScanner] Await completed! Media plugin loaded:", !!MediaPlugin, typeof MediaPlugin);
    } catch (error) {
      console.error("[photoScanner] Error loading Media plugin:", error);
      throw error;
    }
    
    if (!MediaPlugin) {
      console.warn("[photoScanner] Media plugin not available");
      return [];
    }

    // Check if getMedias method exists
    console.log("[photoScanner] Checking MediaPlugin methods...");
    console.log("[photoScanner] MediaPlugin type:", typeof MediaPlugin);
    console.log("[photoScanner] MediaPlugin.getMedias exists:", typeof MediaPlugin.getMedias);
    console.log("[photoScanner] MediaPlugin methods:", Object.keys(MediaPlugin));
    
    if (typeof MediaPlugin.getMedias !== "function") {
      console.error("[photoScanner] getMedias is not a function on MediaPlugin!");
      console.error("[photoScanner] MediaPlugin:", MediaPlugin);
      throw new Error("MediaPlugin.getMedias is not available");
    }

    console.log("[photoScanner] Getting last scan timestamp...");
    const lastScanTimestamp = await getLastPhotoScanTimestamp();
    console.log("[photoScanner] Last scan timestamp:", lastScanTimestamp);

    // Get recent photos from device library (last 100 photos, sorted by creation date descending)
    // This will get photos newer than our last scan
    console.log("[photoScanner] Calling MediaPlugin.getMedias...");
    let getMediasPromise: Promise<any>;
    try {
      console.log("[photoScanner] About to call getMedias with options:", {
        quantity: 100,
        types: "photos",
        sort: [{ key: "creationDate", ascending: false }],
      });
      getMediasPromise = MediaPlugin.getMedias({
        quantity: 100,
        types: "photos",
        sort: [{ key: "creationDate", ascending: false }],
        thumbnailWidth: 512, // Smaller thumbnails for faster loading
        thumbnailHeight: 512,
        thumbnailQuality: 80,
      });
      console.log("[photoScanner] getMedias called, promise created:", !!getMediasPromise);
    } catch (error) {
      console.error("[photoScanner] Error calling getMedias:", error);
      throw error;
    }
    
    console.log("[photoScanner] Setting up timeout (30s)...");
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.error("[photoScanner] Timeout reached!");
        reject(new Error("Photo scanning timed out after 30 seconds"));
      }, 30000);
    });
    
    console.log("[photoScanner] Waiting for getMedias or timeout...");
    let result: any;
    try {
      result = await Promise.race([getMediasPromise, timeoutPromise]);
      console.log("[photoScanner] Promise resolved!");
    } catch (error) {
      console.error("[photoScanner] Error in Promise.race:", error);
      throw error;
    }

    console.log(`[photoScanner] getMedias returned ${result?.medias?.length || 0} photos`);

    if (!result.medias || result.medias.length === 0) {
      console.log("[photoScanner] No photos found in library");
      return [];
    }

    const existingPhotos = await getPendingPhotosForUser(userId);
    const existingTimestamps = new Set(
      existingPhotos.map((p) => {
        const time = new Date(p.timestamp).getTime();
        // Round to nearest second for comparison
        return Math.floor(time / 1000);
      })
    );

    const scannedPhotos: ScannedPhoto[] = [];

    // Process each photo (using thumbnails only for now)
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
          continue;
        }

        // Extract GPS coordinates from media location if available
        let latitude: number | null = null;
        let longitude: number | null = null;
        if (media.location) {
          latitude = media.location.latitude;
          longitude = media.location.longitude;
        }

        // Use creation date from media
        let photoTimestamp = media.creationDate;
        if (!photoTimestamp || photoTimestamp === "Invalid Date") {
          photoTimestamp = new Date().toISOString();
        }

        // Use thumbnail from Media plugin response if available
        let thumbnailUrl: string | undefined;
        try {
          if (media.thumbnail) {
            // Thumbnail is base64 data URL or path
            if (typeof media.thumbnail === "string") {
              if (media.thumbnail.startsWith("data:")) {
                thumbnailUrl = media.thumbnail;
              } else {
                // It's a path, convert it
                try {
                  const thumbnailData = await Filesystem.readFile({
                    path: media.thumbnail,
                  });
                  thumbnailUrl = `data:image/jpeg;base64,${thumbnailData.data}`;
                } catch (e) {
                  console.warn("[photoScanner] Failed to load thumbnail from path:", e);
                }
              }
            } else if (media.thumbnail.base64) {
              // Thumbnail might be an object with base64 property
              thumbnailUrl = `data:image/jpeg;base64,${media.thumbnail.base64}`;
            }
          }
          
          // Fallback: if no thumbnail, we'll show a placeholder in the UI
          // Loading full images here would be too slow
        } catch (e) {
          console.warn("[photoScanner] Error processing thumbnail:", e);
        }

        scannedPhotos.push({
          identifier: media.identifier,
          latitude,
          longitude,
          timestamp: photoTimestamp,
          thumbnailUrl,
        });
      } catch (error) {
        console.error("[photoScanner] Error processing photo:", error);
        // Continue with next photo
      }
    }

    console.log(`[photoScanner] Found ${scannedPhotos.length} new photos`);
    return scannedPhotos;
  } catch (error) {
    console.error("[photoScanner] Error scanning photos:", error);
    // Check if it's a permission error or other recoverable error
    if (error instanceof Error) {
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes("permission") || errorMsg.includes("denied")) {
        console.warn("[photoScanner] Photo library permission not granted");
        throw new Error("Photo library permission not granted. Please grant permission in Settings.");
      } else if (errorMsg.includes("unimplemented") || errorMsg.includes("not available")) {
        console.warn("[photoScanner] getMedias not available on this platform");
        throw new Error("Photo scanning is not available on this platform.");
      } else {
        console.error("[photoScanner] Unexpected error:", error);
        throw error;
      }
    } else {
      console.error("[photoScanner] Unknown error:", error);
      throw error;
    }
  }
}

/**
 * Add selected photos to the app and update last scan timestamp
 */
export async function addSelectedPhotos(
  userId: string,
  photos: ScannedPhoto[],
  tripIds?: string[]
): Promise<number> {
  if (!isNativePlatform()) {
    return 0;
  }

  const MediaPlugin = await getMediaPlugin();
  if (!MediaPlugin) {
    throw new Error("Media plugin not available");
  }

  let addedCount = 0;

  for (const scannedPhoto of photos) {
    try {
      // Load full image if not already loaded
      let imageFile: File;
      if (scannedPhoto._fullImageFile) {
        imageFile = scannedPhoto._fullImageFile;
      } else {
        console.log(`[photoScanner] Loading full image for ${scannedPhoto.identifier}...`);
        const { file } = await loadFullImage(MediaPlugin, scannedPhoto.identifier);
        imageFile = file;
        
        // Try to extract GPS from EXIF if not already set
        let latitude = scannedPhoto.latitude;
        let longitude = scannedPhoto.longitude;
        if (!latitude || !longitude) {
          const exifData = await extractExifData(imageFile);
          if (exifData.latitude && exifData.longitude) {
            latitude = exifData.latitude;
            longitude = exifData.longitude;
          }
        }
        
        // Update timestamp from EXIF if needed
        let timestamp = scannedPhoto.timestamp;
        const exifData = await extractExifData(imageFile);
        if (exifData.timestamp) {
          timestamp = exifData.timestamp;
        }

        // Compress the image
        const compressedFile = await compressImage(imageFile);

        // Add to pending photos
        await addPendingPhoto({
          user_id: userId,
          latitude,
          longitude,
          timestamp,
          blob: compressedFile,
          trip_ids: tripIds && tripIds.length > 0 ? tripIds : undefined,
        });

        addedCount++;
      }
    } catch (error) {
      console.error(`[photoScanner] Error adding photo ${scannedPhoto.identifier}:`, error);
    }
  }

  // Update last scan timestamp after successfully adding photos
  if (addedCount > 0) {
    await setLastPhotoScanTimestamp(Date.now());
  }

  return addedCount;
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

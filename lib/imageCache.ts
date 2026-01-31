/**
 * Local image caching utility using IndexedDB and Cache API
 * Reduces egress fees by caching images locally
 */

const DB_NAME = 'travel-photo-cache';
const DB_VERSION = 1;
const STORE_NAME = 'photos';
const CACHE_NAME = 'travel-photos-cache';

interface CachedPhoto {
  photoId: string;
  blob: Blob;
  url: string;
  timestamp: number;
  expiresAt: number; // Signed URLs expire after 1 hour, cache for 50 minutes
}

/**
 * Initialize IndexedDB database
 */
async function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'photoId' });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
    };
  });
}

/**
 * Get cached image from IndexedDB
 */
export async function getCachedImage(photoId: string): Promise<string | null> {
  // Check if IndexedDB is available
  if (typeof window === 'undefined' || !window.indexedDB) {
    return null;
  }

  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(photoId);

      request.onerror = () => {
        // Silently fail if IndexedDB is not available
        resolve(null);
      };
      request.onsuccess = () => {
        const cached: CachedPhoto | undefined = request.result;
        if (cached && cached.expiresAt > Date.now()) {
          // Return cached blob URL
          resolve(cached.url);
        } else {
          // Cache expired or doesn't exist
          if (cached) {
            // Clean up expired cache
            URL.revokeObjectURL(cached.url);
            const deleteTransaction = db.transaction([STORE_NAME], 'readwrite');
            deleteTransaction.objectStore(STORE_NAME).delete(photoId);
          }
          resolve(null);
        }
      };
    });
  } catch (error) {
    // Silently fail if IndexedDB is not available (e.g., private browsing mode)
    console.warn('IndexedDB not available, skipping cache:', error);
    return null;
  }
}

/**
 * Cache image in IndexedDB
 */
export async function cacheImage(
  photoId: string,
  blob: Blob,
  signedUrl: string
): Promise<void> {
  // Check if IndexedDB is available
  if (typeof window === 'undefined' || !window.indexedDB) {
    return;
  }

  try {
    const db = await initDB();
    const blobUrl = URL.createObjectURL(blob);
    
    // Cache expires 50 minutes from now (signed URLs expire after 1 hour)
    const expiresAt = Date.now() + 50 * 60 * 1000;

    const cached: CachedPhoto = {
      photoId,
      blob,
      url: blobUrl,
      timestamp: Date.now(),
      expiresAt,
    };

    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      // Revoke old URL if exists
      store.get(photoId).onsuccess = (event) => {
        const oldCached = (event.target as IDBRequest<CachedPhoto>).result;
        if (oldCached) {
          URL.revokeObjectURL(oldCached.url);
        }
      };

      const request = store.put(cached);
      request.onerror = () => {
        // Silently fail if caching fails
        resolve();
      };
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    // Silently fail if IndexedDB is not available (e.g., private browsing mode)
    console.warn('IndexedDB not available, skipping cache:', error);
  }
}

/**
 * Fetch image with caching - checks cache first, then fetches from URL
 */
export async function fetchImageWithCache(
  photoId: string,
  signedUrl: string
): Promise<string> {
  // Check IndexedDB cache first
  const cachedUrl = await getCachedImage(photoId);
  if (cachedUrl) {
    return cachedUrl;
  }

  // Not in cache, fetch from URL
  try {
    const response = await fetch(signedUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const blob = await response.blob();
    
    // Cache the blob
    await cacheImage(photoId, blob, signedUrl);
    
    // Return the cached blob URL
    const cachedUrl = await getCachedImage(photoId);
    return cachedUrl || signedUrl;
  } catch (error) {
    console.error('Error fetching image:', error);
    // Fallback to signed URL if fetch fails
    return signedUrl;
  }
}

/**
 * Clear expired cache entries
 */
export async function clearExpiredCache(): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('expiresAt');
      const request = index.openCursor(IDBKeyRange.upperBound(Date.now()));

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const cached: CachedPhoto = cursor.value;
          URL.revokeObjectURL(cached.url);
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  } catch (error) {
    console.error('Error clearing expired cache:', error);
  }
}

/**
 * Clear all cached images
 */
export async function clearAllCache(): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();

      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const cached: CachedPhoto = cursor.value;
          URL.revokeObjectURL(cached.url);
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  } catch (error) {
    console.error('Error clearing all cache:', error);
  }
}

// Clean up expired cache on load (only if IndexedDB is available)
if (typeof window !== 'undefined' && window.indexedDB) {
  clearExpiredCache().catch(() => {
    // Silently fail if cleanup fails
  });
}


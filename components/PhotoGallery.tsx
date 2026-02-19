"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import type { User as FirebaseUser } from "firebase/auth";
import exifr from "exifr";
import { compressImage } from "@/lib/imageCompression";
import { isNativePlatform } from "@/lib/capacitor";
import { createClient } from "@/lib/firebase/client";
import { addPhotoMetadata, getPhotoMetadataForUser, deletePhotoMetadata } from "@/lib/firebase/photos";
import {
  addPendingPhoto,
  getPendingPhotosForUser,
  deletePendingPhoto,
} from "@/lib/localStore";
import {
  addLocalPhoto,
  getAllLocalPhotosForUser,
  getLocalPhotoUrl,
  deleteLocalPhoto,
  openPhotoInViewer,
  type LocalPhotoRecord,
} from "@/lib/localPhotoStorage";

/** Convert EXIF DMS array [deg, min, sec] to decimal degrees. Ref is e.g. 'N'/'S', 'E'/'W'. */
function dmsToDecimal(
  dms: number[] | { [key: number]: number },
  ref?: string
): number | null {
  const arr = Array.isArray(dms) ? dms : [dms[0], dms[1], dms[2]];
  if (!arr.length || arr.some((n) => n == null || isNaN(Number(n)))) return null;
  const [d = 0, m = 0, s = 0] = arr.map(Number);
  let decimal = d + m / 60 + s / 3600;
  if (ref === "S" || ref === "W") decimal = -decimal;
  return decimal;
}

interface Photo {
  id: string;
  user_id: string;
  storage_path: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  url?: string;
  /** When set, photo is from local storage (IndexedDB/iOS); can use openPhotoInViewer on iOS */
  localRecord?: LocalPhotoRecord;
}

interface PhotoGalleryProps {
  user: FirebaseUser | null;
  onPhotoClick?: (photo: Photo) => void;
  onPhotosUpdate?: () => void;
}

export default function PhotoGallery({ user, onPhotoClick, onPhotosUpdate }: PhotoGalleryProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
  const [error, setError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingUrlsRef = useRef<Map<string, string>>(new Map());
  const blobUrlsRef = useRef<Map<string, string>>(new Map());

  const db = useMemo(() => (typeof window !== "undefined" ? createClient().db : null), []);

  const fetchPhotos = useCallback(async () => {
    if (!user) {
      setPhotos([]);
      return;
    }

    setLoading(true);
    try {
      const [localRecords, pendingList, firestorePhotos] = await Promise.all([
        getAllLocalPhotosForUser(user.uid),
        getPendingPhotosForUser(user.uid),
        db ? getPhotoMetadataForUser(db, user.uid) : Promise.resolve([]),
      ]);

      // Revoke previous pending and local blob URLs to avoid leaks
      pendingUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingUrlsRef.current.clear();
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current.clear();

      const localPhotos: Photo[] = await Promise.all(
        localRecords.map(async (rec) => {
          const url = await getLocalPhotoUrl(rec);
          blobUrlsRef.current.set(rec.id, url);
          return {
            id: rec.id,
            user_id: rec.user_id,
            storage_path: "",
            latitude: rec.latitude,
            longitude: rec.longitude,
            timestamp: rec.timestamp,
            url,
            localRecord: rec,
          };
        })
      );

      const pendingPhotos: Photo[] = pendingList.map((p) => {
        const url = URL.createObjectURL(p.blob);
        pendingUrlsRef.current.set(p.id, url);
        return {
          id: p.id,
          user_id: p.user_id,
          storage_path: "",
          latitude: p.latitude,
          longitude: p.longitude,
          timestamp: p.timestamp,
          url,
        };
      });

      const localAndPendingIds = new Set([...localPhotos.map((p) => p.id), ...pendingPhotos.map((p) => p.id)]);
      const firestoreOnlyPhotos: Photo[] = firestorePhotos
        .filter((m) => !localAndPendingIds.has(m.id))
        .map((m) => ({
          id: m.id,
          user_id: m.user_id,
          storage_path: "",
          latitude: m.latitude,
          longitude: m.longitude,
          timestamp: m.timestamp,
          url: undefined,
        }));

      const merged = [...pendingPhotos, ...localPhotos, ...firestoreOnlyPhotos].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ) as Photo[];
      setPhotos(merged);
    } catch (error) {
      console.error("Error fetching photos:", error);
      setError("Failed to load photos");
    } finally {
      setLoading(false);
    }
  }, [user, db]);

  useEffect(() => {
    if (user) {
      fetchPhotos();
    }
  }, [user, fetchPhotos]);

  const extractExifData = useCallback(async (file: File): Promise<{
    latitude?: number;
    longitude?: number;
    timestamp?: string;
  }> => {
    const result: { latitude?: number; longitude?: number; timestamp?: string } = {};
    try {
      const exifData = await exifr.parse(file, {
        gps: true,
        exif: true,
      });

      if (!exifData) return result;

      // GPS: try normalized lat/long first, then raw DMS
      let lat = exifData.latitude ?? exifData.GPSLatitude ?? exifData.Latitude;
      let lng = exifData.longitude ?? exifData.GPSLongitude ?? exifData.Longitude;
      if (typeof lat === "number" && typeof lng === "number") {
        result.latitude = lat;
        result.longitude = lng;
      } else if (Array.isArray(lat) && Array.isArray(lng)) {
        const latNum = dmsToDecimal(lat, exifData.GPSLatitudeRef ?? exifData.latitudeRef);
        const lngNum = dmsToDecimal(lng, exifData.GPSLongitudeRef ?? exifData.longitudeRef);
        if (latNum != null && lngNum != null) {
          result.latitude = latNum;
          result.longitude = lngNum;
        }
      }

      // Date/time: try all common EXIF date tags
      const dateTimeOriginal =
        exifData.DateTimeOriginal ??
        exifData.DateTime ??
        exifData.CreateDate ??
        exifData.ModifyDate ??
        exifData.SubSecTimeOriginal;
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
      console.warn("Could not extract EXIF data:", error);
    }
    return result;
  }, []);

  const uploadPhoto = useCallback(
    async (file: File, latitude?: number, longitude?: number, fileId?: string) => {
      if (!user) {
        setError("Please sign in to upload photos");
        return;
      }

      if (fileId) {
        setUploadProgress((prev) => ({ ...prev, [fileId]: 0 }));
      }

      try {
        if (!user) {
          throw new Error("User not authenticated");
        }

        let finalLatitude: number | undefined;
        let finalLongitude: number | undefined;
        let photoTimestamp: string | undefined;

        const exifData = await extractExifData(file);
        if (exifData.latitude != null && exifData.longitude != null) {
          finalLatitude = exifData.latitude;
          finalLongitude = exifData.longitude;
        }
        if (exifData.timestamp) {
          photoTimestamp = exifData.timestamp;
        }

        // If no GPS in EXIF (e.g. camera capture, stripped file), use device position so photo appears on map
        if ((finalLatitude == null || finalLongitude == null) && typeof navigator !== "undefined" && navigator.geolocation) {
          try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 8000,
                maximumAge: 60000,
              });
            });
            if (pos?.coords) {
              finalLatitude = finalLatitude ?? pos.coords.latitude;
              finalLongitude = finalLongitude ?? pos.coords.longitude;
            }
          } catch (e) {
            console.warn("Could not get device position for photo:", e);
          }
        }

        if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 10 }));

        // Compress locally first (before storing and uploading)
        const compressedFile = await compressImage(file);

        if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 30 }));

        // Store locally first so it appears immediately
        const pending = await addPendingPhoto({
          user_id: user.uid,
          latitude: finalLatitude ?? null,
          longitude: finalLongitude ?? null,
          timestamp: photoTimestamp ?? new Date().toISOString(),
          blob: compressedFile,
        });

        const localUrl = URL.createObjectURL(compressedFile);
        pendingUrlsRef.current.set(pending.id, localUrl);

        setPhotos((prev) => [
          {
            id: pending.id,
            user_id: pending.user_id,
            storage_path: "",
            latitude: pending.latitude,
            longitude: pending.longitude,
            timestamp: pending.timestamp,
            url: localUrl,
          },
          ...prev,
        ]);

        if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 50 }));

        onPhotosUpdate?.();

        // Persist to local storage (IndexedDB / iOS Filesystem) and Firestore metadata in background
        (async () => {
          try {
            if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 70 }));

            const rec = await addLocalPhoto(user.uid, compressedFile, {
              latitude: finalLatitude ?? null,
              longitude: finalLongitude ?? null,
              timestamp: photoTimestamp ?? pending.timestamp,
            });

            if (db) {
              await addPhotoMetadata(db, user.uid, {
                id: rec.id,
                local_name: rec.id,
                latitude: rec.latitude,
                longitude: rec.longitude,
                timestamp: rec.timestamp,
                created_at: rec.created_at,
              });
            }

            if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 100 }));

            const urlToRevoke = pendingUrlsRef.current.get(pending.id);
            if (urlToRevoke) {
              URL.revokeObjectURL(urlToRevoke);
              pendingUrlsRef.current.delete(pending.id);
            }
            await deletePendingPhoto(pending.id);
            await fetchPhotos();
            onPhotosUpdate?.();
          } catch (err) {
            console.error("Background local photo save failed:", err);
            if (fileId) {
              setUploadProgress((prev) => {
                const next = { ...prev };
                delete next[fileId];
                return next;
              });
            }
          }
        })();
      } catch (error: unknown) {
        console.error("Error uploading photo:", error);
        if (fileId) {
          setUploadProgress((prev) => {
            const newPrev = { ...prev };
            delete newPrev[fileId];
            return newPrev;
          });
        }
        throw error;
      }
    },
    [user, db, extractExifData, fetchPhotos, onPhotosUpdate]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      setUploading(true);
      setError(null);

      // Upload all files concurrently
      // Location will be extracted from EXIF data in each photo
      const uploadPromises = files.map((file, index) => {
        const fileId = `${Date.now()}-${index}`;
        return uploadPhoto(file, undefined, undefined, fileId).catch((error) => {
          console.error(`Error uploading ${file.name}:`, error);
          return null;
        });
      });

      try {
        await Promise.all(uploadPromises);
        
        // Refresh photos list after all uploads complete
        await fetchPhotos();
        // Notify parent component
        if (onPhotosUpdate) {
          onPhotosUpdate();
        }
        
        // Clear progress after a short delay
        setTimeout(() => {
          setUploadProgress({});
        }, 1000);
      } catch (error: any) {
        setError(error.message || "Failed to upload some photos");
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [uploadPhoto, fetchPhotos, onPhotosUpdate]
  );

  /** On native: pick from photo library, compress locally, upload once. No redownloading. */
  const pickFromNativeLibrary = useCallback(
    async () => {
      if (!user) return;
      setUploading(true);
      setError(null);
      try {
        const result = await Camera.pickImages({
          limit: 50,
          quality: 100, // We compress ourselves before upload
        });
        if (!result.photos?.length) {
          setUploading(false);
          return;
        }
        const uploadPromises = result.photos.map(async (photo, index) => {
          const fileId = `native-${Date.now()}-${index}`;
          setUploadProgress((prev) => ({ ...prev, [fileId]: 0 }));
          try {
            const path = photo.path ?? photo.webPath;
            if (!path) throw new Error("Photo path missing");
            const webPath = Capacitor.convertFileSrc(path);
            const response = await fetch(webPath);
            if (!response.ok) throw new Error("Failed to read photo");
            const blob = await response.blob();
            const file = new File([blob], `photo-${Date.now()}-${index}.jpg`, {
              type: blob.type || "image/jpeg",
            });
            await uploadPhoto(file, undefined, undefined, fileId);
          } catch (err) {
            console.error(`Error uploading photo ${index}:`, err);
            setUploadProgress((prev) => {
              const next = { ...prev };
              delete next[fileId];
              return next;
            });
          }
        });
        await Promise.all(uploadPromises);
        await fetchPhotos();
        if (onPhotosUpdate) onPhotosUpdate();
        setTimeout(() => setUploadProgress({}), 1000);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to pick photos";
        setError(message);
      } finally {
        setUploading(false);
      }
    },
    [user, uploadPhoto, fetchPhotos, onPhotosUpdate]
  );

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, // Use back camera on mobile
      });
      setCameraStream(stream);
      setShowCamera(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error: any) {
      console.error("Error accessing camera:", error);
      setError("Failed to access camera. Please check permissions.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    setShowCamera(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [cameraStream]);

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    if (!context) return;

    // Set canvas dimensions to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Draw video frame to canvas
    context.drawImage(video, 0, 0);

    // Convert canvas to blob
    canvas.toBlob(async (blob) => {
      if (!blob) return;

      setUploading(true);
      setError(null);

      // Create file from blob
      const file = new File([blob], `photo-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });

      try {
        // Location will be extracted from EXIF data if available
        // Note: Camera capture already creates JPEG, but compression will still optimize it
        await uploadPhoto(file, undefined, undefined);
        // Refresh photos list after upload
        await fetchPhotos();
        // Notify parent component
        if (onPhotosUpdate) {
          onPhotosUpdate();
        }
        stopCamera();
      } catch (error: any) {
        console.error("Error uploading captured photo:", error);
        setError(error.message || "Failed to upload photo");
      } finally {
        setUploading(false);
      }
    }, "image/jpeg", 0.9);
  }, [uploadPhoto, stopCamera, fetchPhotos, onPhotosUpdate]);

  const downloadPhoto = useCallback(async (photo: Photo) => {
    if (!user) {
      setError("Please sign in to download photos");
      return;
    }

    if (photo.user_id !== user.uid) {
      setError("You don't have permission to download this photo");
      return;
    }

    const downloadUrl = photo.url;
    if (!downloadUrl) {
      setError("Photo not available");
      return;
    }

    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        setError("Failed to download photo");
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `photo-${photo.id}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      if (navigator.share && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
        try {
          const file = new File([blob], `photo-${photo.id}.jpg`, { type: "image/jpeg" });
          await navigator.share({ files: [file], title: "Travel Photo" });
        } catch {
          // Share API failed, download already happened
        }
      }
    } catch (error) {
      console.error("Error downloading photo:", error);
      setError("Failed to download photo");
    }
  }, []);

  const viewPhotoInViewer = useCallback(async (photo: Photo) => {
    if (photo.localRecord) {
      await openPhotoInViewer(photo.localRecord);
    } else if (photo.url) {
      window.open(photo.url, "_blank");
    }
  }, []);

  const deletePhoto = useCallback(
    async (photo: Photo) => {
      if (!user) {
        setError("Please sign in to delete photos");
        return;
      }

      if (photo.user_id !== user.uid) {
        setError("You don't have permission to delete this photo");
        return;
      }

      if (!confirm("Are you sure you want to delete this photo?")) return;

      const isPending = !photo.localRecord && !!photo.url;
      if (isPending) {
        const urlToRevoke = pendingUrlsRef.current.get(photo.id);
        if (urlToRevoke) {
          URL.revokeObjectURL(urlToRevoke);
          pendingUrlsRef.current.delete(photo.id);
        }
        await deletePendingPhoto(photo.id);
        setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
        if (onPhotosUpdate) onPhotosUpdate();
        return;
      }

      setPhotos((prevPhotos) => prevPhotos.filter((p) => p.id !== photo.id));
      try {
        if (photo.localRecord) {
          await deleteLocalPhoto(photo.id);
          const urlToRevoke = blobUrlsRef.current.get(photo.id);
          if (urlToRevoke) {
            URL.revokeObjectURL(urlToRevoke);
            blobUrlsRef.current.delete(photo.id);
          }
        }
        if (db && (photo.localRecord || photo.url === undefined)) {
          await deletePhotoMetadata(db, photo.id);
        }
        if (onPhotosUpdate) onPhotosUpdate();
      } catch (error) {
        console.error("Error deleting photo:", error);
        setError("Failed to delete photo");
        await fetchPhotos();
      }
    },
    [user, db, fetchPhotos, onPhotosUpdate]
  );

  const deleteSelectedPhotos = useCallback(
    async () => {
      if (!user || selectedPhotos.size === 0) return;

      const photosToDelete = photos.filter((p) => selectedPhotos.has(p.id));
      const invalidPhotos = photosToDelete.filter((p) => p.user_id !== user.uid);
      if (invalidPhotos.length > 0) {
        setError("Some photos cannot be deleted");
        return;
      }

      if (!confirm(`Are you sure you want to delete ${selectedPhotos.size} photo(s)?`)) return;

      setPhotos((prevPhotos) => prevPhotos.filter((p) => !selectedPhotos.has(p.id)));

      try {
        await Promise.all(
          photosToDelete
            .filter((p) => p.localRecord)
            .map((photo) => deleteLocalPhoto(photo.id))
        );
        await Promise.all(
          photosToDelete
            .filter((p) => !p.localRecord)
            .map(async (p) => {
              const urlToRevoke = pendingUrlsRef.current.get(p.id);
              if (urlToRevoke) {
                URL.revokeObjectURL(urlToRevoke);
                pendingUrlsRef.current.delete(p.id);
              }
              await deletePendingPhoto(p.id);
            })
        );
        if (db) {
          await Promise.all(
            photosToDelete
              .filter((p) => p.localRecord || p.url === undefined)
              .map((p) => deletePhotoMetadata(db, p.id))
          );
        }
        photosToDelete.forEach((p) => {
          const u = blobUrlsRef.current.get(p.id);
          if (u) {
            URL.revokeObjectURL(u);
            blobUrlsRef.current.delete(p.id);
          }
        });
        setSelectedPhotos(new Set());
        setSelectionMode(false);
        if (onPhotosUpdate) onPhotosUpdate();
      } catch (error) {
        console.error("Error deleting photos:", error);
        setError("Failed to delete some photos");
        await fetchPhotos();
      }
    },
    [user, selectedPhotos, photos, onPhotosUpdate, fetchPhotos]
  );

  const togglePhotoSelection = useCallback((photoId: string) => {
    setSelectedPhotos((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(photoId)) {
        newSet.delete(photoId);
      } else {
        newSet.add(photoId);
      }
      return newSet;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedPhotos.size === photos.length) {
      setSelectedPhotos(new Set());
    } else {
      setSelectedPhotos(new Set(photos.map((p) => p.id)));
    }
  }, [photos, selectedPhotos]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  if (!user) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center">
          Sign in to view and upload photos
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          Photos
        </h2>
        <div className="flex gap-2">
          {selectionMode ? (
            <>
              <button
                onClick={toggleSelectAll}
                className="px-4 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded-md text-sm font-medium"
              >
                {selectedPhotos.size === photos.length ? "Deselect All" : "Select All"}
              </button>
              <button
                onClick={deleteSelectedPhotos}
                disabled={selectedPhotos.size === 0}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-md text-sm font-medium disabled:opacity-50"
              >
                Delete ({selectedPhotos.size})
              </button>
              <button
                onClick={() => {
                  setSelectionMode(false);
                  setSelectedPhotos(new Set());
                }}
                className="px-4 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded-md text-sm font-medium"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setSelectionMode(true)}
                className="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-md text-sm font-medium"
              >
                Select
              </button>
              {isNativePlatform() ? (
                <button
                  onClick={pickFromNativeLibrary}
                  disabled={uploading}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50"
                >
                  {uploading ? "Uploading..." : "Pick from Library"}
                </button>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50"
                >
                  {uploading ? "Uploading..." : "Upload Photos"}
                </button>
              )}
              <button
                onClick={showCamera ? stopCamera : startCamera}
                className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-md text-sm font-medium"
              >
                {showCamera ? "Cancel" : "Camera"}
              </button>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
          <p className="text-red-800 dark:text-red-200 text-sm">{error}</p>
        </div>
      )}

      {uploading && Object.keys(uploadProgress).length > 0 && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
          <p className="text-blue-800 dark:text-blue-200 text-sm mb-2">
            Uploading {Object.keys(uploadProgress).length} photo(s)...
          </p>
          <div className="space-y-2">
            {Object.entries(uploadProgress).map(([fileId, progress]) => (
              <div key={fileId} className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {showCamera && (
        <div className="mb-4 relative bg-black rounded-lg overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-64 object-cover"
          />
          <canvas ref={canvasRef} className="hidden" />
          <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-4">
            <button
              onClick={stopCamera}
              className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-full font-medium"
            >
              Cancel
            </button>
            <button
              onClick={capturePhoto}
              className="px-6 py-3 bg-green-500 hover:bg-green-600 text-white rounded-full font-medium"
            >
              Capture
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">Loading photos...</p>
        </div>
      ) : photos.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">
            No photos yet. Upload or take a photo to get started!
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {photos.map((photo) => (
            <div
              key={photo.id}
              className={`relative group aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-zinc-800 ${
                selectionMode && selectedPhotos.has(photo.id) ? "ring-4 ring-blue-500" : ""
              }`}
            >
              {selectionMode && (
                <div className="absolute top-2 left-2 z-10">
                  <input
                    type="checkbox"
                    checked={selectedPhotos.has(photo.id)}
                    onChange={() => togglePhotoSelection(photo.id)}
                    className="w-6 h-6 cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              )}
              {photo.url ? (
                <img
                  src={photo.url}
                  alt={`Photo from ${new Date(photo.timestamp).toLocaleDateString()}`}
                  className={`w-full h-full object-cover ${
                    selectionMode ? "cursor-pointer" : "cursor-pointer"
                  }`}
                  onClick={() => {
                    if (selectionMode) {
                      togglePhotoSelection(photo.id);
                    } else if (photo.latitude && photo.longitude && onPhotoClick) {
                      onPhotoClick(photo);
                    }
                  }}
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-2">
                  <p className="text-gray-400 text-sm text-center">
                    {photo.localRecord ? "Loading..." : "Not on this device"}
                  </p>
                  {!photo.localRecord && photo.latitude != null && photo.longitude != null && (
                    <p className="text-gray-500 text-xs mt-1">Location saved</p>
                  )}
                </div>
              )}
              {!selectionMode && (
                <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 transition-opacity flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                  {photo.latitude && photo.longitude && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onPhotoClick) {
                          onPhotoClick(photo);
                        }
                      }}
                      className="px-3 py-2 bg-green-500 hover:bg-green-600 text-white rounded-md text-sm"
                      title="Show on Map"
                    >
                      Map
                    </button>
                  )}
                  {isNativePlatform() && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        viewPhotoInViewer(photo);
                      }}
                      className="px-3 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-md text-sm"
                      title="Open in system viewer"
                    >
                      View
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadPhoto(photo);
                    }}
                    className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-sm"
                    title="Download/Save to Camera Roll"
                  >
                    Download
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deletePhoto(photo);
                    }}
                    className="px-3 py-2 bg-red-500 hover:bg-red-600 text-white rounded-md text-sm"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


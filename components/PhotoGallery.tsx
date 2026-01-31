"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import exifr from "exifr";
import { compressImage } from "@/lib/imageCompression";
import { getCachedImage, fetchImageWithCache } from "@/lib/imageCache";
import { isNativePlatform } from "@/lib/capacitor";
import {
  addPendingPhoto,
  getPendingPhotosForUser,
  deletePendingPhoto,
} from "@/lib/localStore";

interface Photo {
  id: string;
  user_id: string;
  storage_path: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  url?: string;
}

interface PhotoGalleryProps {
  user: User | null;
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
  const supabase = createClient();

  const fetchPhotos = useCallback(async () => {
    if (!user) {
      setPhotos([]);
      return;
    }

    setLoading(true);
    try {
      const [remoteResult, pendingList] = await Promise.all([
        supabase
          .from("photos")
          .select("*")
          .eq("user_id", user.id)
          .order("timestamp", { ascending: false }),
        getPendingPhotosForUser(user.id),
      ]);

      if (remoteResult.error) throw remoteResult.error;
      const data = remoteResult.data || [];

      // Revoke previous pending object URLs to avoid leaks
      pendingUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingUrlsRef.current.clear();

      const photosWithUrls = await Promise.all(
        data.map(async (photo: Photo) => {
          if (!photo.storage_path.startsWith(`${user.id}/`)) {
            return { ...photo, url: undefined };
          }
          if (photo.user_id !== user.id) {
            return { ...photo, url: undefined };
          }
          // Use local cache first — only create signed URL and download if we don't have it
          const localUrl = await getCachedImage(photo.id);
          if (localUrl) {
            return { ...photo, url: localUrl };
          }
          const { data: urlData } = await supabase.storage
            .from("photos")
            .createSignedUrl(photo.storage_path, 3600);
          if (!urlData?.signedUrl) {
            return { ...photo, url: undefined };
          }
          const cachedUrl = await fetchImageWithCache(photo.id, urlData.signedUrl);
          return { ...photo, url: cachedUrl };
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

      const merged = [...pendingPhotos, ...photosWithUrls].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ) as Photo[];
      setPhotos(merged);
    } catch (error) {
      console.error("Error fetching photos:", error);
      setError("Failed to load photos");
    } finally {
      setLoading(false);
    }
  }, [user, supabase]);

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
    try {
      // Extract EXIF data including GPS coordinates and date/time
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
      // Try different EXIF date fields (different cameras use different fields)
      const dateTimeOriginal = exifData?.DateTimeOriginal || exifData?.DateTime || exifData?.CreateDate;
      
      if (dateTimeOriginal) {
        let photoDate: Date;
        
        // Handle different date formats
        if (typeof dateTimeOriginal === 'string') {
          // EXIF date format is typically "YYYY:MM:DD HH:MM:SS"
          // Convert "YYYY:MM:DD HH:MM:SS" to "YYYY-MM-DD HH:MM:SS" for Date parsing
          const dateStr = dateTimeOriginal.replace(/(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
          photoDate = new Date(dateStr);
        } else if (dateTimeOriginal instanceof Date) {
          photoDate = dateTimeOriginal;
        } else {
          // Try to parse as number (Unix timestamp)
          photoDate = new Date(dateTimeOriginal);
        }
        
        // Validate the date is reasonable (not invalid, not in the future, not too old)
        if (!isNaN(photoDate.getTime()) && 
            photoDate.getTime() <= Date.now() && 
            photoDate.getTime() > new Date('1900-01-01').getTime()) {
          result.timestamp = photoDate.toISOString();
        }
      }
      
      return result;
    } catch (error) {
      // EXIF extraction failed, continue without EXIF data
      console.log("Could not extract EXIF data:", error);
    }
    
    return {};
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
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
        if (authError || !authUser) {
          throw new Error("Authentication failed. Please sign in again.");
        }
        if (authUser.id !== user.id) {
          throw new Error("User ID mismatch. Please refresh the page.");
        }

        let finalLatitude: number | undefined;
        let finalLongitude: number | undefined;
        let photoTimestamp: string | undefined;

        const exifData = await extractExifData(file);
        if (exifData.latitude && exifData.longitude) {
          finalLatitude = exifData.latitude;
          finalLongitude = exifData.longitude;
        }
        if (exifData.timestamp) {
          photoTimestamp = exifData.timestamp;
        }

        if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 10 }));

        // Compress locally first (before storing and uploading)
        const compressedFile = await compressImage(file);

        if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 30 }));

        // Store locally first so it appears immediately
        const pending = await addPendingPhoto({
          user_id: authUser.id,
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

        // Upload to Supabase in background
        (async () => {
          try {
            const fileName = `${authUser.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
            const { error: uploadError } = await supabase.storage
              .from("photos")
              .upload(fileName, compressedFile, {
                cacheControl: "3600",
                upsert: false,
              });

            if (uploadError) throw uploadError;

            if (fileId) setUploadProgress((prev) => ({ ...prev, [fileId]: 70 }));

            const insertData: Record<string, unknown> = {
              user_id: authUser.id,
              storage_path: fileName,
              latitude: finalLatitude ?? null,
              longitude: finalLongitude ?? null,
            };
            if (photoTimestamp) insertData.timestamp = photoTimestamp;

            const { error: dbError } = await supabase
              .from("photos")
              .insert(insertData)
              .select()
              .single();

            if (dbError) throw dbError;

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
            console.error("Background photo upload failed:", err);
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
    [user, supabase, extractExifData, fetchPhotos, onPhotosUpdate]
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

    if (photo.user_id !== user.id) {
      setError("You don't have permission to download this photo");
      return;
    }

    // Pending (local-only) photo: use existing url (blob URL)
    const isPending = !photo.storage_path || !photo.storage_path.startsWith(`${user.id}/`);
    if (isPending && photo.url) {
      try {
        const response = await fetch(photo.url);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `photo-${photo.id}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      } catch (e) {
        setError("Failed to download photo");
      }
      return;
    }

    if (!photo.storage_path.startsWith(`${user.id}/`)) {
      setError("Invalid photo path");
      return;
    }

    // Use local cache first — only create signed URL if we don't have it locally
    let downloadUrl = photo.url ?? (await getCachedImage(photo.id));
    if (!downloadUrl) {
      const { data: urlData, error: urlError } = await supabase.storage
        .from("photos")
        .createSignedUrl(photo.storage_path, 3600);

      if (urlError || !urlData) {
        setError("Failed to generate download URL");
        return;
      }
      downloadUrl = urlData.signedUrl;
    }

    try {
      // Fetch the image
      const response = await fetch(downloadUrl);
      const blob = await response.blob();

      // Create a temporary URL
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `photo-${photo.id}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      // For mobile devices, try to save to camera roll
      if (navigator.share && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
        try {
          const file = new File([blob], `photo-${photo.id}.jpg`, {
            type: "image/jpeg",
          });
          await navigator.share({
            files: [file],
            title: "Travel Photo",
          });
        } catch (shareError) {
          // Share API failed, download already happened
        }
      }
    } catch (error) {
      console.error("Error downloading photo:", error);
      setError("Failed to download photo");
    }
  }, []);

  const deletePhoto = useCallback(
    async (photo: Photo) => {
      if (!user) {
        setError("Please sign in to delete photos");
        return;
      }

      if (photo.user_id !== user.id) {
        setError("You don't have permission to delete this photo");
        return;
      }

      if (!confirm("Are you sure you want to delete this photo?")) return;

      const isPending = !photo.storage_path || !photo.storage_path.startsWith(`${user.id}/`);

      if (isPending) {
        // Local-only pending photo: remove from local store and UI
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

      if (!isPending) {
        // Synced photo: delete from storage and database
        setPhotos((prevPhotos) => prevPhotos.filter((p) => p.id !== photo.id));

        try {
          const { error: storageError } = await supabase.storage
            .from("photos")
            .remove([photo.storage_path]);

          if (storageError) throw storageError;

          const { error: dbError } = await supabase
            .from("photos")
            .delete()
            .eq("id", photo.id)
            .eq("user_id", user.id);

          if (dbError) throw dbError;

          if (onPhotosUpdate) onPhotosUpdate();
        } catch (error) {
          console.error("Error deleting photo:", error);
          setError("Failed to delete photo");
          await fetchPhotos();
        }
      }
    },
    [user, supabase, fetchPhotos, onPhotosUpdate]
  );

  const deleteSelectedPhotos = useCallback(
    async () => {
      if (!user || selectedPhotos.size === 0) return;

      const photosToDelete = photos.filter((p) => selectedPhotos.has(p.id));

      // Security check: Verify all photos belong to current user
      const invalidPhotos = photosToDelete.filter(
        (p) => p.user_id !== user.id || !p.storage_path.startsWith(`${user.id}/`)
      );

      if (invalidPhotos.length > 0) {
        setError("Some photos cannot be deleted");
        return;
      }

      if (!confirm(`Are you sure you want to delete ${selectedPhotos.size} photo(s)?`)) return;

      // Optimistically remove from UI
      setPhotos((prevPhotos) => prevPhotos.filter((p) => !selectedPhotos.has(p.id)));

      try {
        // Delete from storage
        const storagePaths = photosToDelete.map((p) => p.storage_path);
        const { error: storageError } = await supabase.storage
          .from("photos")
          .remove(storagePaths);

        if (storageError) throw storageError;

        // Delete from database
        const photoIds = Array.from(selectedPhotos);
        const { error: dbError } = await supabase
          .from("photos")
          .delete()
          .in("id", photoIds)
          .eq("user_id", user.id);

        if (dbError) throw dbError;

        // Clear selection and exit selection mode
        setSelectedPhotos(new Set());
        setSelectionMode(false);

        // Notify parent component
        if (onPhotosUpdate) {
          onPhotosUpdate();
        }
      } catch (error) {
        console.error("Error deleting photos:", error);
        setError("Failed to delete some photos");
        // Revert optimistic update on error
        await fetchPhotos();
      }
    },
    [user, supabase, selectedPhotos, photos, onPhotosUpdate, fetchPhotos]
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
                <div className="w-full h-full flex items-center justify-center">
                  <p className="text-gray-400 text-sm">Loading...</p>
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


"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import exifr from "exifr";

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const supabase = createClient();

  const fetchPhotos = useCallback(async () => {
    if (!user) {
      setPhotos([]);
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("photos")
        .select("*")
        .eq("user_id", user.id)
        .order("timestamp", { ascending: false });

      if (error) throw error;

      // Get signed URLs for all photos - with security validation
      const photosWithUrls = await Promise.all(
        (data || []).map(async (photo) => {
          // Security check: Ensure storage_path starts with user ID
          if (!photo.storage_path.startsWith(`${user.id}/`)) {
            console.error(`Security: Photo ${photo.id} storage_path doesn't match user ID`);
            return {
              ...photo,
              url: null,
            };
          }

          // Verify photo belongs to current user (double-check)
          if (photo.user_id !== user.id) {
            console.error(`Security: Photo ${photo.id} doesn't belong to current user`);
            return {
              ...photo,
              url: null,
            };
          }

          const { data: urlData } = await supabase.storage
            .from("photos")
            .createSignedUrl(photo.storage_path, 3600);

          return {
            ...photo,
            url: urlData?.signedUrl || null,
          };
        })
      );

      setPhotos(photosWithUrls);
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

  const extractExifLocation = useCallback(async (file: File): Promise<{ latitude?: number; longitude?: number }> => {
    try {
      // Extract EXIF data, specifically GPS coordinates
      const exifData = await exifr.gps(file);
      
      if (exifData && exifData.latitude && exifData.longitude) {
        return {
          latitude: exifData.latitude,
          longitude: exifData.longitude,
        };
      }
    } catch (error) {
      // EXIF extraction failed, continue without location
      console.log("Could not extract EXIF location data:", error);
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
        // Verify authentication session before proceeding
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
        
        if (authError || !authUser) {
          throw new Error("Authentication failed. Please sign in again.");
        }

        if (authUser.id !== user.id) {
          throw new Error("User ID mismatch. Please refresh the page.");
        }

        // Extract EXIF location data if not provided
        let finalLatitude = latitude;
        let finalLongitude = longitude;
        
        if (!finalLatitude || !finalLongitude) {
          const exifLocation = await extractExifLocation(file);
          if (exifLocation.latitude && exifLocation.longitude) {
            finalLatitude = exifLocation.latitude;
            finalLongitude = exifLocation.longitude;
          }
        }

        // Generate unique filename
        const fileExt = file.name.split(".").pop();
        const fileName = `${user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

        if (fileId) {
          setUploadProgress((prev) => ({ ...prev, [fileId]: 30 }));
        }

        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from("photos")
          .upload(fileName, file, {
            cacheControl: "3600",
            upsert: false,
          });

        if (uploadError) {
          console.error("Storage upload error:", uploadError);
          throw uploadError;
        }

        if (fileId) {
          setUploadProgress((prev) => ({ ...prev, [fileId]: 70 }));
        }

        // Save photo metadata to database
        // Use the authenticated user's ID from the session
        const { data: insertData, error: dbError } = await supabase
          .from("photos")
          .insert({
            user_id: authUser.id, // Use authUser.id to ensure it matches auth.uid()
            storage_path: fileName,
            latitude: finalLatitude || null,
            longitude: finalLongitude || null,
          })
          .select()
          .single();

        if (dbError) {
          console.error("Database insert error:", dbError);
          console.error("Attempted insert with user_id:", authUser.id);
          throw dbError;
        }

        if (fileId) {
          setUploadProgress((prev) => ({ ...prev, [fileId]: 100 }));
        }
      } catch (error: any) {
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
    [user, supabase, extractExifLocation]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      setUploading(true);
      setError(null);

      // Get current location if available (shared for all photos)
      let latitude: number | undefined;
      let longitude: number | undefined;

      if (navigator.geolocation) {
        try {
          const position = await new Promise<GeolocationPosition>(
            (resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                timeout: 5000,
              });
            }
          );
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
        } catch (error) {
          // Location not available, continue without it
        }
      }

      // Upload all files concurrently
      const uploadPromises = files.map((file, index) => {
        const fileId = `${Date.now()}-${index}`;
        return uploadPhoto(file, latitude, longitude, fileId).catch((error) => {
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

      // Get current location if available
      let latitude: number | undefined;
      let longitude: number | undefined;

      if (navigator.geolocation) {
        try {
          const position = await new Promise<GeolocationPosition>(
            (resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                timeout: 5000,
              });
            }
          );
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
        } catch (error) {
          // Location not available, continue without it
        }
      }

      // Create file from blob
      const file = new File([blob], `photo-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });

      try {
        await uploadPhoto(file, latitude, longitude);
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

    // Security check: Verify photo belongs to current user
    if (photo.user_id !== user.id) {
      setError("You don't have permission to download this photo");
      return;
    }

    // Security check: Verify storage_path format
    if (!photo.storage_path.startsWith(`${user.id}/`)) {
      setError("Invalid photo path");
      return;
    }

    // Generate a fresh signed URL for download
    let downloadUrl = photo.url;
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

      // Security check: Verify photo belongs to current user
      if (photo.user_id !== user.id) {
        setError("You don't have permission to delete this photo");
        return;
      }

      // Security check: Verify storage_path format
      if (!photo.storage_path.startsWith(`${user.id}/`)) {
        setError("Invalid photo path");
        return;
      }

      if (!confirm("Are you sure you want to delete this photo?")) return;

      try {
        // Delete from storage (with path validation)
        const { error: storageError } = await supabase.storage
          .from("photos")
          .remove([photo.storage_path]);

        if (storageError) throw storageError;

        // Delete from database (with user ID check for extra security)
        const { error: dbError } = await supabase
          .from("photos")
          .delete()
          .eq("id", photo.id)
          .eq("user_id", user.id); // Extra security: ensure user owns the photo

        if (dbError) throw dbError;

        await fetchPhotos();
        // Notify parent component
        if (onPhotosUpdate) {
          onPhotosUpdate();
        }
      } catch (error) {
        console.error("Error deleting photo:", error);
        setError("Failed to delete photo");
      }
    },
    [user, supabase, fetchPhotos, onPhotosUpdate]
  );

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
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload Photos"}
          </button>
          <button
            onClick={showCamera ? stopCamera : startCamera}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-md text-sm font-medium"
          >
            {showCamera ? "Cancel" : "Camera"}
          </button>
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
              className="relative group aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-zinc-800"
            >
              {photo.url ? (
                <img
                  src={photo.url}
                  alt={`Photo from ${new Date(photo.timestamp).toLocaleDateString()}`}
                  className="w-full h-full object-cover cursor-pointer"
                  onClick={() => {
                    if (photo.latitude && photo.longitude && onPhotoClick) {
                      onPhotoClick(photo);
                    }
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <p className="text-gray-400 text-sm">Loading...</p>
                </div>
              )}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


import imageCompression from 'browser-image-compression';

export interface CompressionOptions {
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
  useWebWorker?: boolean;
  quality?: number;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxSizeMB: 0.5, // Compress to max 500KB
  maxWidthOrHeight: 1920, // Max dimension 1920px (good for most displays)
  useWebWorker: true,
  quality: 0.8, // 80% quality - good balance between size and quality
};

/**
 * Compresses an image file before upload to reduce storage and egress costs
 */
export async function compressImage(
  file: File,
  options?: CompressionOptions
): Promise<File> {
  const compressionOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  try {
    const compressedFile = await imageCompression(file, compressionOptions);
    console.log(
      `Image compressed: ${(file.size / 1024 / 1024).toFixed(2)}MB -> ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB`
    );
    return compressedFile;
  } catch (error) {
    console.error('Error compressing image:', error);
    // If compression fails, return original file
    return file;
  }
}



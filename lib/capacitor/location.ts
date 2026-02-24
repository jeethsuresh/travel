import { registerPlugin } from "@capacitor/core";

type NativeLocation = {
  lat: number;
  lng: number;
  timestamp: string;
};

export type NativePendingLocation = {
  id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  wait_time?: number;
  trip_ids?: string[];
  created_at?: string;
  uploaded?: boolean;
};

type NativeGetLocationsResult = {
  locations: NativePendingLocation[];
};

interface LocationPlugin {
  startTracking(): Promise<void>;
  stopTracking(): Promise<void>;
  getCurrentLocation(): Promise<NativeLocation>;
  getLocations(): Promise<NativeGetLocationsResult>;
}

const NativeLocationPlugin = registerPlugin<LocationPlugin>("LocationPlugin");

export async function startTrackingNative(): Promise<void> {
  await NativeLocationPlugin.startTracking();
}

export async function stopTrackingNative(): Promise<void> {
  await NativeLocationPlugin.stopTracking();
}

export async function getCurrentLocationNative(): Promise<{
  lat: number;
  lng: number;
  timestamp: string;
} | null> {
  try {
    const loc = await NativeLocationPlugin.getCurrentLocation();
    return {
      lat: loc.lat,
      lng: loc.lng,
      timestamp: loc.timestamp,
    };
  } catch {
    return null;
  }
}

export async function getAllLocationsNative(): Promise<NativePendingLocation[]> {
  const result = await NativeLocationPlugin.getLocations();
  return result.locations ?? [];
}



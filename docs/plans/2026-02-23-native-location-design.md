# Native Location Architecture (iOS) – Design & Verification Notes

**Goal:** Replace the Capacitor Geolocation plugin with a Swift-native location layer that uses Capacitor Preferences/UserDefaults as the single source of truth for tracking state and locations, and uploads positions to Firestore in both foreground and background.

## Architecture Overview

- **Storage & models (Swift)**
  - `LocationStorage` (`LocationStorage.swift`) centralizes:
    - Models: `FirebaseAuth`, `PendingLocation`.
    - Keys: `CapacitorStorage.jeethtravel.firebaseAuth`, `CapacitorStorage.jeethtravel.pending`, `CapacitorStorage.jeethtravel.trackingEnabled`.
    - Helpers:
      - `isTrackingEnabled` / `setTrackingEnabled`.
      - `loadAuth` / `saveAuth`.
      - `loadPendingLocations` / `savePendingLocations`.
      - `appendOrUpdateLocation(newLocation:userId:pending:now:)` encapsulating proximity + `wait_time` behavior.
  - Preferences (`UserDefaults`) are the **canonical** store for auth, tracking state, and all pending locations.

- **Background execution (Swift)**
  - `BackgroundLocationTask`:
    - Registered/scheduled from `AppDelegate`.
    - On run:
      - Checks `LocationStorage.isTrackingEnabled` and exits early (with logs) when tracking is off.
      - Loads and, if needed, refreshes `FirebaseAuth` and persists via `LocationStorage.saveAuth`.
      - Fetches a single `CLLocation` using its internal `CLLocationManager`.
      - Uses `LocationStorage.appendOrUpdateLocation` and `LocationStorage.savePendingLocations` to maintain the `pending` array.
      - Calls `BackgroundLocationTask.patchFirestore` (now module-visible) to upsert the `PendingLocation` document via Firestore REST, updating the `uploaded` flag in `pending`.

- **Foreground execution (Swift plugin)**
  - `LocationPlugin` (`LocationPlugin.swift`, registered as `"LocationPlugin"` in `ios/App/App/capacitor.config.json`):
    - Lifecycle:
      - Configures a dedicated `CLLocationManager` (high accuracy, background updates allowed) and logs load.
    - Public API exposed to Capacitor:
      - `startTracking`:
        - Sets `LocationStorage.setTrackingEnabled(true)`.
        - Requests `Always` authorization when appropriate.
        - Starts continuous `CLLocationManager` updates.
      - `stopTracking`:
        - Sets `LocationStorage.setTrackingEnabled(false)`.
        - Stops location updates.
      - `getCurrentLocation`:
        - Returns the last pending location from Preferences, or falls back to the last in-memory `CLLocation`.
      - `getLocations`:
        - Returns the full `pending` array as plain JSON objects.
    - Delegate behavior:
      - `didUpdateLocations`:
        - Records the latest fix into `LocationStorage` using `appendOrUpdateLocation`.
        - Attempts Firestore upsert via `BackgroundLocationTask.patchFirestore`, updating `uploaded` in `pending`.
      - When auth is missing/invalid:
        - Stores locations locally only (using `storeLocationWithoutUpload`) and logs the condition.

- **JS / Capacitor bridge**
  - `lib/capacitor/location.ts`:
    - Registers the `LocationPlugin` via `registerPlugin`.
    - Exposes:
      - `startTrackingNative` / `stopTrackingNative`.
      - `getCurrentLocationNative` → `{ lat, lng, timestamp } | null`.
      - `getAllLocationsNative` → full pending locations array.

- **React map & tracking (web + native)**
  - `components/Map.tsx`:
    - **Web path:**
      - Continues to use `navigator.geolocation` for `LocationTracker` (unchanged behavior).
      - Saves locations via existing `saveLocation` logic (IndexedDB + Firestore JS SDK).
    - **Native iOS path:**
      - Removes all usage of `@capacitor/geolocation`.
      - Uses `startTrackingNative` / `stopTrackingNative` to toggle native Swift tracking.
      - Uses `getCurrentLocationNative` to seed `currentLocation` for UI display.
      - Still writes tracking state to `Preferences` (`jeethtravel.trackingEnabled`) for redundancy with the Swift side.
  - `@capacitor/geolocation` has been removed from:
    - Imports in `Map.tsx`.
    - `package.json` / `package-lock.json`.
    - iOS package class lists (`GeolocationPlugin` removed; `LocationPlugin` added).

- **Background JS runner**
  - `public/runners/background.js`:
    - Continues to act purely as a **pending uploader**:
      - Reads `CapacitorStorage.jeethtravel.pending` and `CapacitorStorage.jeethtravel.firebaseAuth`.
      - PATCHes un-uploaded documents to Firestore using REST.
    - It does **not** request geolocation; all location capture is now performed in Swift.

## Suggested Manual Test Plan

### 1. iOS foreground tracking

- Build native app (`npm run cap` or equivalent) and launch on a physical device.
- Sign in so `jeethtravel.firebaseAuth` is populated.
- From the main map UI:
  - Start tracking.
  - Move around (or simulate movement).
  - Verify:
    - `Preferences` (Xcode debugger / logs) show:
      - `CapacitorStorage.jeethtravel.trackingEnabled = "true"`.
      - `CapacitorStorage.jeethtravel.pending` contains appended/updated `PendingLocation` entries with reasonable `wait_time` values.
    - Firestore `locations` collection contains upserted documents with matching IDs and fields.
    - Map UI updates `currentLocation` and breadcrumb trail based on server-backed locations as before.

### 2. iOS background tracking

- With tracking enabled:
  - Background the app and keep the device moving for several minutes.
  - Inspect OS logs for `BackgroundLocationTask` and `LocationPlugin` messages confirming:
    - Background task execution and successful `requestLocation`.
    - Early exit when `trackingEnabled` is false.
  - Bring app back to foreground and verify:
    - More `PendingLocation` entries were added while backgrounded.
    - New entries have `uploaded: true` when Firestore upserts succeed.

### 3. Tracking toggle behavior

- From the UI:
  - Start tracking, confirm `trackingEnabled` is `"true"` in Preferences.
  - Stop tracking, confirm `trackingEnabled` becomes `"false"`.
  - With tracking off, observe:
    - `BackgroundLocationTask.run` logs indicate “tracking disabled … skipping run”.
    - No new Firestore `locations` documents are written while off.

### 4. Web behavior regression check

- Run the app in a browser (`npm run dev`):
  - Start/stop tracking on web.
  - Ensure:
    - `navigator.geolocation` prompts and behavior are unchanged.
    - Location saving and map rendering still work as before.
  - Confirm that removing `@capacitor/geolocation` did **not** affect the web-only path.

### 5. Failure scenarios

- On iOS:
  - Deny location permission and attempt to start tracking.
  - Verify:
    - Native logs indicate denied authorization.
    - UI surfaces an error state (or at minimum, does not crash).
  - In case of Firestore failures (e.g., offline):
    - Confirm `PendingLocation.uploaded` remains `false` and entries stay in Preferences for later retry (via background JS runner or future Swift runs).


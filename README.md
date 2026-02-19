# Travel Location Tracker

A Progressive Web App (PWA) built with Next.js that tracks and displays your location history over time. Features include:

- 🔐 **Firebase Authentication** - Secure user login and signup
- 🗺️ **Interactive Map** - View your location history on an interactive map using Leaflet
- 📍 **Location Tracking** - Real-time location tracking with start/stop controls
- 📊 **Location History** - View and browse your past locations
- 📱 **PWA Support** - Installable as a mobile app

## Prerequisites

- Node.js 18+ and npm
- A Firebase account and project

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Firebase

1. Create a new project at [Firebase Console](https://console.firebase.google.com)
2. Enable Authentication:
   - Go to Authentication > Sign-in method
   - Enable Email/Password authentication
3. Create Firestore Database:
   - Go to Firestore Database
   - Create database in production mode
   - Deploy security rules from `firestore.rules`
4. Set up Storage:
   - Go to Storage
   - Get started with default settings
   - Deploy storage rules from `storage.rules`

### 3. Configure Environment Variables

Create a `.env.local` file in the root directory:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
```

You can find these values in your Firebase project settings under Project Settings > General > Your apps.

### 4. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

### Authentication
- Sign up with email and password
- Sign in to existing accounts
- Secure session management with Firebase Auth

### Location Tracking
- Click "Start Tracking" to begin recording your location
- Location data is automatically saved to Firestore
- Click "Stop Tracking" to pause recording
- Real-time location updates displayed on the map

### Map View
- Interactive map showing all recorded locations
- Polyline connecting all location points
- Markers for each recorded location
- Auto-centers on your current location

### Location History
- View all your past locations in a scrollable list
- See coordinates and timestamps for each location
- Refresh button to reload latest data

## Database Schema

The app uses Firestore collections with the following structure:

### Locations Collection
- `id` - Document ID (auto-generated)
- `user_id` - User UID from Firebase Auth
- `latitude` - Location latitude
- `longitude` - Location longitude
- `timestamp` - Firestore Timestamp when the location was recorded
- `wait_time` - Time in seconds spent at this location
- `created_at` - Firestore Timestamp for record creation

### Photos Collection
- `id` - Document ID (auto-generated)
- `user_id` - User UID from Firebase Auth
- `storage_path` - Path to photo in Firebase Storage
- `latitude` - Photo location latitude (optional)
- `longitude` - Photo location longitude (optional)
- `timestamp` - Firestore Timestamp when photo was taken
- `created_at` - Firestore Timestamp for record creation

### Friend Requests Collection
- `id` - Document ID (auto-generated)
- `requester_id` - User UID who sent the request
- `requester_email` - Email of requester
- `recipient_email` - Email of recipient
- `status` - Request status: "pending", "accepted", or "rejected"
- `created_at` - Firestore Timestamp
- `responded_at` - Firestore Timestamp when responded (optional)

### Friendships Collection
- `id` - Document ID (auto-generated)
- `user_id` - User UID
- `friend_id` - Friend's user UID
- `friend_email` - Friend's email
- `share_location_with_friend` - Boolean indicating if location sharing is enabled
- `created_at` - Firestore Timestamp

Data is also stored locally in IndexedDB (pending locations and photos) for offline support. Security rules are configured in `firestore.rules` to ensure users can only access their own data.

## Building for Production

```bash
npm run build
npm start
```

## Native iOS App (Capacitor)

The app can run as a native iOS app using Capacitor, with native geolocation and photo library access. Photos are picked from the device library, compressed locally, and uploaded once to Firebase Storage for storage and web viewing (no redownloading on each open).

### Build and run on iOS

1. **Build the web app for native** (static export):

   ```bash
   IS_NATIVE=1 npm run build
   ```

   Or use the script:

   ```bash
   npm run build:native
   ```

2. **Sync to iOS** (copies `out` into the native project):

   ```bash
   npx cap sync ios
   ```

3. **Open in Xcode and run** on a simulator or device:

   ```bash
   npx cap open ios
   ```

   In Xcode, select your target device and press Run (⌘R). For a real device, set your Team under Signing & Capabilities.

### What’s different on native

- **Geolocation**: Uses `@capacitor/geolocation` for iOS location permissions and tracking.
- **Photos**: On iOS, “Pick from Library” uses the native photo picker (`Camera.pickImages`). Selected images are read from the device, compressed locally, then uploaded once to Supabase. The existing cache still applies so images aren’t re-downloaded unnecessarily.

### Requirements

- macOS with Xcode 15+
- Apple Developer account for running on a physical device

## PWA Installation

The app is configured as a Progressive Web App. To install:

1. Visit the app in a supported browser (Chrome, Edge, Safari)
2. Look for the install prompt or use the browser's install option
3. The app will be installed and can be launched like a native app

**Note:** For full PWA functionality, add icon files (`icon-192x192.png` and `icon-512x512.png`) to the `public` directory. The app will work without them, but installation prompts may not appear.

## Technologies Used

- **Next.js 16** - React framework with App Router
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Firebase** - Authentication, Firestore database, and Storage
- **Leaflet** - Interactive maps
- **next-pwa** - PWA support

## License

MIT

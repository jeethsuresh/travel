# Travel Location Tracker

A Progressive Web App (PWA) built with Next.js that tracks and displays your location history over time. Features include:

- 🔐 **Supabase Authentication** - Secure user login and signup
- 🗺️ **Interactive Map** - View your location history on an interactive map using Leaflet
- 📍 **Location Tracking** - Real-time location tracking with start/stop controls
- 📊 **Location History** - View and browse your past locations
- 📱 **PWA Support** - Installable as a mobile app

## Prerequisites

- Node.js 18+ and npm
- A Supabase account and project

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to your project's SQL Editor
3. Run the SQL script from `supabase/schema.sql` to create the `locations` table and set up Row Level Security policies

### 3. Configure Environment Variables

Create a `.env.local` file in the root directory:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

You can find these values in your Supabase project settings under API.

### 4. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

### Authentication
- Sign up with email and password
- Sign in to existing accounts
- Secure session management with Supabase Auth

### Location Tracking
- Click "Start Tracking" to begin recording your location
- Location data is automatically saved to Supabase
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

The app uses a single `locations` table with the following structure:

- `id` - UUID primary key
- `user_id` - Foreign key to auth.users
- `latitude` - Location latitude
- `longitude` - Location longitude
- `timestamp` - When the location was recorded
- `created_at` - Record creation timestamp

Row Level Security (RLS) is enabled, ensuring users can only access their own location data.

## Building for Production

```bash
npm run build
npm start
```

## Native iOS App (Capacitor)

The app can run as a native iOS app using Capacitor, with native geolocation and photo library access. Photos are picked from the device library, compressed locally, and uploaded once to Supabase for storage and web viewing (no redownloading on each open).

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
- **Supabase** - Authentication and database
- **Leaflet** - Interactive maps
- **next-pwa** - PWA support

## License

MIT

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { 
  getAuth, 
  initializeAuth, 
  type Auth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

// Firebase configuration - these are replaced at build time by Next.js
// For Capacitor builds, ensure .env file is present when running `npm run build:native`
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Runtime validation: log if config is missing (helps debug Capacitor builds)
if (typeof window !== "undefined" && (!firebaseConfig.apiKey || !firebaseConfig.projectId)) {
  console.error("[Firebase] ⚠️  Missing Firebase configuration at runtime!", {
    hasApiKey: !!firebaseConfig.apiKey,
    hasProjectId: !!firebaseConfig.projectId,
    hasAuthDomain: !!firebaseConfig.authDomain,
    note: "This usually means environment variables weren't embedded during build. Check that .env exists when building.",
  });
}

function getApp(): FirebaseApp | null {
  if (typeof window === "undefined") {
    console.log("[Firebase] getApp: window is undefined (SSR)");
    return null;
  }
  const apps = getApps();
  if (apps.length > 0) {
    console.log("[Firebase] getApp: Using existing app instance");
    return apps[0] as FirebaseApp;
  }
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.error("[Firebase] getApp: Missing config", {
      hasApiKey: !!firebaseConfig.apiKey,
      hasProjectId: !!firebaseConfig.projectId,
      config: {
        apiKey: firebaseConfig.apiKey ? `${firebaseConfig.apiKey.substring(0, 10)}...` : "missing",
        projectId: firebaseConfig.projectId || "missing",
        authDomain: firebaseConfig.authDomain || "missing",
      },
    });
    return null;
  }
  console.log("[Firebase] getApp: Initializing new Firebase app");
  try {
    const app = initializeApp(firebaseConfig);
    console.log("[Firebase] getApp: Firebase app initialized successfully");
    return app;
  } catch (error) {
    console.error("[Firebase] getApp: Failed to initialize Firebase app", error);
    return null;
  }
}

let auth: Auth | null = null;
let firestore: Firestore | null = null;

export function getFirebaseAuth(): Auth | null {
  if (typeof window === "undefined") {
    console.log("[Firebase] getFirebaseAuth: window is undefined (SSR)");
    return null;
  }
  const app = getApp();
  if (!app) {
    console.warn("[Firebase] getFirebaseAuth: No app instance available");
    return null;
  }
  if (!auth) {
    console.log("[Firebase] getFirebaseAuth: Creating new auth instance");
    
    // For Capacitor apps, we need to explicitly configure auth persistence
    // This prevents issues where Firebase Auth stops working on iOS
    // See: https://stackoverflow.com/questions/79244738/ios-app-built-in-reactjs-capacitor-stops-working-when-i-add-firebase-auth
    try {
      // Try to initialize with explicit persistence configuration
      // This is required for Capacitor to work properly
      auth = initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      });
      console.log("[Firebase] getFirebaseAuth: Auth initialized with explicit persistence (Capacitor-compatible)");
    } catch (error: any) {
      // If auth is already initialized (e.g., by getAuth elsewhere), use getAuth instead
      if (error?.code === "auth/already-initialized") {
        console.log("[Firebase] getFirebaseAuth: Auth already initialized, using getAuth");
        auth = getAuth(app);
      } else {
        console.error("[Firebase] getFirebaseAuth: Failed to initialize auth", error);
        // Fallback to getAuth as last resort
        auth = getAuth(app);
      }
    }
    
    if (auth) {
      console.log("[Firebase] getFirebaseAuth: Auth instance created", {
        currentUser: auth.currentUser?.uid || null,
        appName: app.name,
      });
    }
  } else {
    console.log("[Firebase] getFirebaseAuth: Using existing auth instance");
  }
  return auth;
}

export function getFirebaseFirestore(): Firestore | null {
  if (typeof window === "undefined") return null;
  const app = getApp();
  if (!app) return null;
  if (!firestore) firestore = getFirestore(app);
  return firestore;
}

export function getFirebaseProjectId(): string | null {
  return firebaseConfig.projectId ?? null;
}

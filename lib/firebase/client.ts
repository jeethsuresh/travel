/**
 * Firebase client-side initialization
 * This file provides Firebase services for client components
 */

import { getAuth, Auth } from "firebase/auth";
import { getFirestore, Firestore } from "firebase/firestore";
import { initializeApp, getApps, FirebaseApp } from "firebase/app";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Initialize Firebase app (singleton pattern)
let app: FirebaseApp;
const initStartTime = typeof window !== "undefined" ? Date.now() : 0;

if (typeof window !== "undefined") {
  console.log("[Firebase:Client] Initializing Firebase client", {
    existingApps: getApps().length,
    hasApiKey: !!firebaseConfig.apiKey,
    hasProjectId: !!firebaseConfig.projectId,
    hasAuthDomain: !!firebaseConfig.authDomain,
  });
  
  if (getApps().length === 0) {
    console.log("[Firebase:Client] No existing apps - initializing new Firebase app");
    const initTime = Date.now();
    app = initializeApp(firebaseConfig);
    const elapsed = Date.now() - initTime;
    console.log(`[Firebase:Client] Firebase app initialized in ${elapsed}ms`);
  } else {
    console.log("[Firebase:Client] Using existing Firebase app");
    app = getApps()[0];
  }
  
  if (initStartTime > 0) {
    const totalElapsed = Date.now() - initStartTime;
    console.log(`[Firebase:Client] Total Firebase client initialization took ${totalElapsed}ms`);
  }
} else {
  // Server-side: return a placeholder that will be initialized on client
  console.log("[Firebase:Client] Server-side - returning placeholder");
  app = {} as FirebaseApp;
}

// Initialize services (no Storage; photos are stored locally, metadata in Firestore)
const serviceInitStart = typeof window !== "undefined" ? Date.now() : 0;
export const auth: Auth = typeof window !== "undefined" ? getAuth(app) : ({} as Auth);
export const db: Firestore = typeof window !== "undefined" ? getFirestore(app) : ({} as Firestore);

if (typeof window !== "undefined" && serviceInitStart > 0) {
  const serviceElapsed = Date.now() - serviceInitStart;
  console.log(`[Firebase:Client] Auth and Firestore services initialized in ${serviceElapsed}ms`, {
    authAvailable: !!auth,
    dbAvailable: !!db,
  });
}

export function createClient() {
  return {
    auth,
    db,
  };
}

export type FirebaseClient = ReturnType<typeof createClient>;

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
if (typeof window !== "undefined") {
  if (getApps().length === 0) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApps()[0];
  }
} else {
  // Server-side: return a placeholder that will be initialized on client
  app = {} as FirebaseApp;
}

// Initialize services (no Storage; photos are stored locally, metadata in Firestore)
export const auth: Auth = typeof window !== "undefined" ? getAuth(app) : ({} as Auth);
export const db: Firestore = typeof window !== "undefined" ? getFirestore(app) : ({} as Firestore);

export function createClient() {
  return {
    auth,
    db,
  };
}

export type FirebaseClient = ReturnType<typeof createClient>;

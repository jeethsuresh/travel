"use client";

import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseFirestore } from "@/lib/firebase";

export interface UserSettings {
  explorerMode: boolean;
  displayName: string;
}

const DEFAULT_SETTINGS: UserSettings = {
  explorerMode: false,
  displayName: "",
};

const COLLECTION = "user_settings";

function settingsRef(userId: string) {
  const db = getFirebaseFirestore();
  if (!db) return null;
  return doc(db, COLLECTION, userId);
}

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const ref = settingsRef(userId);
  if (!ref) return { ...DEFAULT_SETTINGS };
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return { ...DEFAULT_SETTINGS };
    const data = snap.data();
    return {
      explorerMode: !!data?.explorerMode,
      displayName: typeof data?.displayName === "string" ? data.displayName : "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateUserSettings(
  userId: string,
  patch: Partial<UserSettings>
): Promise<void> {
  const ref = settingsRef(userId);
  if (!ref) return;
  const current = await getUserSettings(userId);
  await setDoc(ref, { ...current, ...patch }, { merge: true });
}

export function subscribeUserSettings(
  userId: string,
  onSettings: (settings: UserSettings) => void
): Unsubscribe {
  const ref = settingsRef(userId);
  if (!ref) {
    onSettings({ ...DEFAULT_SETTINGS });
    return () => {};
  }
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onSettings({ ...DEFAULT_SETTINGS });
        return;
      }
      const data = snap.data();
      onSettings({
        explorerMode: !!data?.explorerMode,
        displayName: typeof data?.displayName === "string" ? data.displayName : "",
      });
    },
    () => onSettings({ ...DEFAULT_SETTINGS })
  );
}

export { DEFAULT_SETTINGS };

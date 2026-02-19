"use client";

import { useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase";
import type { User } from "@/lib/types";

interface AuthProps {
  user: User | null;
  onSignOut: () => void;
}

export default function Auth({ user, onSignOut }: AuthProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const auth = getFirebaseAuth();
    if (!auth) {
      setError("Firebase is not configured.");
      setLoading(false);
      return;
    }
    try {
      if (isSignUp) {
        const domain = email.split("@")[1]?.toLowerCase() ?? "";
        if (domain === "localhost" || domain.startsWith("localhost:")) {
          throw new Error("Please use a non-localhost email domain when signing up.");
        }
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: unknown) {
      const message = err && typeof err === "object" && "message" in err ? String((err as { message: string }).message) : "Sign in failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOutClick = async () => {
    const auth = getFirebaseAuth();
    if (auth) await firebaseSignOut(auth);
    onSignOut();
  };

  if (user) {
    return (
      <div className="flex items-center gap-4 p-4 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-600 dark:text-gray-400">Signed in as</p>
          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{user.email ?? user.id}</p>
        </div>
        <button
          type="button"
          onClick={handleSignOutClick}
          className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 transition-colors shrink-0"
        >
          Sign Out
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto p-6 bg-white dark:bg-zinc-900 rounded-lg shadow-md">
      <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-gray-100">
        {isSignUp ? "Sign up" : "Sign in"}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">You must sign in to use the app.</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="auth-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Email
          </label>
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="auth-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Password
          </label>
          <input
            id="auth-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-zinc-800 text-gray-900 dark:text-gray-100"
            placeholder="••••••••"
          />
        </div>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 transition-colors"
        >
          {loading ? "Please wait…" : isSignUp ? "Sign up" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => { setIsSignUp(!isSignUp); setError(null); }}
        className="mt-4 text-sm text-blue-500 hover:text-blue-600"
      >
        {isSignUp ? "Already have an account? Sign in" : "Need an account? Sign up"}
      </button>
    </div>
  );
}

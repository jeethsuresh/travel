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
      console.log("[Auth] handleSubmit called", { isSignUp, email });
    const auth = getFirebaseAuth();
    console.log("[Auth] getFirebaseAuth() returned:", auth ? "Auth instance" : "null");
    if (!auth) {
      const errorMsg = "Firebase is not configured. Please check your environment variables.";
      console.error("[Auth]", errorMsg);
      setError(errorMsg);
      setLoading(false);
      return;
    }
    
    // Log auth configuration for debugging
    console.log("[Auth] Auth configuration:", {
      currentUser: auth.currentUser?.uid || null,
      app: auth.app.name,
      config: {
        apiKey: auth.app.options.apiKey ? `${auth.app.options.apiKey.substring(0, 10)}...` : "missing",
        authDomain: auth.app.options.authDomain || "missing",
        projectId: auth.app.options.projectId || "missing",
      },
    });
    
    // Track when the promise actually starts
    const startTime = Date.now();
    let progressInterval: NodeJS.Timeout | null = null;
    
    try {
      // Add timeout wrapper to prevent infinite hanging
      const authPromise = isSignUp
        ? (async () => {
            const domain = email.split("@")[1]?.toLowerCase() ?? "";
            if (domain === "localhost" || domain.startsWith("localhost:")) {
              throw new Error("Please use a non-localhost email domain when signing up.");
            }
            console.log("[Auth] Creating user with email:", email);
            return await createUserWithEmailAndPassword(auth, email, password);
          })()
        : (async () => {
            console.log("[Auth] Signing in with email:", email);
            return await signInWithEmailAndPassword(auth, email, password);
          })();

      // Longer timeout for mobile networks (60 seconds)
      const timeoutMs = 60000;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("Authentication timed out. This may be a network issue. Please check your internet connection and try again."));
        }, timeoutMs);
      });

      console.log("[Auth] Waiting for auth operation...", { timeoutMs, isSignUp });
      
      // Wrap auth promise to track when it actually starts executing
      const trackedAuthPromise = authPromise.then((result) => {
        const elapsed = Date.now() - startTime;
        console.log("[Auth] Auth operation completed successfully", { elapsedMs: elapsed });
        return result;
      }).catch((error) => {
        const elapsed = Date.now() - startTime;
        console.error("[Auth] Auth operation failed", { elapsedMs: elapsed, error });
        throw error;
      });
      
      // Log progress every 5 seconds
      progressInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log("[Auth] Still waiting for auth...", { elapsedMs: elapsed, timeoutMs });
      }, 5000);
      
      const userCredential = await Promise.race([trackedAuthPromise, timeoutPromise]) as Awaited<typeof authPromise>;
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
      console.log("[Auth] Auth operation successful:", userCredential.user.uid);
      
      // Clear loading immediately - the parent's onAuthStateChanged will update user prop
      // which will cause this component to re-render and show the signed-in state
      console.log("[Auth] Clearing loading state - auth state change should update parent");
      setLoading(false);
    } catch (err: unknown) {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
      console.error("[Auth] Auth error caught:", err);
      console.error("[Auth] Error type:", typeof err);
      console.error("[Auth] Error constructor:", err && typeof err === "object" && err.constructor?.name);
      
      // Log all properties of the error object
      if (err && typeof err === "object") {
        const errAny = err as any;
        console.error("[Auth] Error properties:", {
          code: errAny.code,
          message: errAny.message,
          name: errAny.name,
          stack: errAny.stack,
          customData: errAny.customData,
          toString: String(err),
          // Try to get all enumerable properties
          keys: Object.keys(err),
          entries: Object.entries(err),
        });
      }
      
      let message = "Sign in failed";
      
      // Handle Firebase error (has 'code' property)
      // In Capacitor, errors might not serialize properly, so check directly
      const errAny = err as any;
      const errorCode = errAny?.code;
      const errorMessage = errAny?.message;
      
      if (errorCode) {
        const code = String(errorCode);
        console.log("[Auth] Firebase error code:", code);
        // Map Firebase error codes to user-friendly messages
        if (code === "auth/user-not-found") {
          message = "No account found with this email.";
        } else if (code === "auth/wrong-password") {
          message = "Incorrect password.";
        } else if (code === "auth/invalid-credential") {
          message = "Invalid email or password.";
        } else if (code === "auth/email-already-in-use") {
          message = "An account with this email already exists.";
        } else if (code === "auth/weak-password") {
          message = "Password is too weak. Please use at least 6 characters.";
        } else if (code === "auth/invalid-email") {
          message = "Invalid email address.";
        } else if (code === "auth/network-request-failed") {
          message = "Network error. Please check your internet connection and try again.";
        } else if (code === "auth/too-many-requests") {
          message = "Too many failed attempts. Please try again later.";
        } else if (code === "auth/user-disabled") {
          message = "This account has been disabled.";
        } else {
          message = errorMessage || `Error: ${code}`;
        }
      } else if (errorMessage) {
        // Check if it's a timeout error
        if (errorMessage.includes("timed out")) {
          message = "Authentication is taking longer than expected. This may be due to:\n\n• Slow or unstable internet connection\n• Firebase service temporarily unavailable\n• Network restrictions\n\nPlease check your internet connection and try again.";
        } else {
          message = String(errorMessage);
        }
      } else if (err && typeof err === "object" && "message" in err) {
        const errMsg = String((err as { message: string }).message);
        if (errMsg.includes("timed out")) {
          message = "Authentication is taking longer than expected. This may be due to:\n\n• Slow or unstable internet connection\n• Firebase service temporarily unavailable\n• Network restrictions\n\nPlease check your internet connection and try again.";
        } else {
          message = errMsg;
        }
      } else if (err) {
        // Last resort: try to stringify or convert to string
        try {
          const str = String(err);
          if (str !== "[object Object]") {
            message = str;
          } else {
            message = "Authentication failed. Please check your internet connection and try again.";
          }
        } catch {
          message = "Authentication failed. Please check your internet connection and try again.";
        }
      }
      
      console.error("[Auth] Final error message:", message);
      setError(message);
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
          <div className="text-sm text-red-600 dark:text-red-400 whitespace-pre-line">{error}</div>
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

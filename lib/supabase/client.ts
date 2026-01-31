import { createBrowserClient } from "@supabase/ssr";
import { isNativePlatform } from "@/lib/capacitor";

const CAPACITOR_AUTH_STORAGE_KEY = "sb-capacitor-auth";

/**
 * In Capacitor (iOS/Android), document.cookie often doesn't persist properly
 * for custom URL schemes (e.g. Travel://), so the Supabase session is lost
 * and you don't see locations/photos. Use localStorage so the session persists.
 */
function getCapacitorCookieAdapter(): {
  getAll: () => { name: string; value: string }[] | null;
  setAll: (cookies: { name: string; value: string }[]) => void;
} {
  return {
    getAll() {
      try {
        const raw =
          typeof localStorage !== "undefined"
            ? localStorage.getItem(CAPACITOR_AUTH_STORAGE_KEY)
            : null;
        return raw ? (JSON.parse(raw) as { name: string; value: string }[]) : [];
      } catch {
        return [];
      }
    },
    setAll(cookies: { name: string; value: string }[]) {
      try {
        localStorage.setItem(
          CAPACITOR_AUTH_STORAGE_KEY,
          JSON.stringify(cookies.map(({ name, value }) => ({ name, value })))
        );
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Single Supabase client for the browser. Uses @supabase/ssr's createBrowserClient:
 * - In the browser, the same instance is reused (singleton), so Map, PhotoGallery,
 *   Auth, etc. all share one client and one session.
 * - On web: session is stored in cookies; middleware refreshes tokens.
 * - In Capacitor: session is stored in localStorage so it persists in the WebView
 *   (document.cookie often doesn't for custom schemes), so you see the same
 *   locations/photos as on web when signed in.
 */
export function createClient() {
  const isNative = typeof window !== "undefined" && isNativePlatform();

  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    isNative
      ? {
          cookies: {
            getAll: () => getCapacitorCookieAdapter().getAll(),
            setAll: (cookies) =>
              getCapacitorCookieAdapter().setAll(
                cookies.map(({ name, value }) => ({ name, value }))
              ),
          },
        }
      : undefined
  );
}


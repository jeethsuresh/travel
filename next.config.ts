import type { NextConfig } from "next";
import withPWA from "next-pwa";

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {},
  // Static export for Capacitor iOS (use: npm run build:native)
  ...(process.env.IS_NATIVE === "1" && {
    output: "export",
    images: { unoptimized: true },
  }),
};

const pwaConfig = withPWA({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
});

export default pwaConfig(nextConfig);

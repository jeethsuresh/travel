import type { NextConfig } from "next";
import withPWA from "next-pwa";

// Verify environment variables are present for Capacitor builds
if (process.env.IS_NATIVE === "1") {
  const requiredVars = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
  ];
  
  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables for Capacitor build:');
    missing.forEach(varName => console.error(`   - ${varName}`));
    console.error('\n💡 Make sure your .env file exists and contains all required variables.');
    console.error('   See .env.example for reference.\n');
    process.exit(1);
  }
  
  console.log('✅ All required environment variables are present for Capacitor build');
}

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

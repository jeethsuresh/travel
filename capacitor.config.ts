import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jeethtravel.app",
  appName: "Travel",
  webDir: "out",
  server: {
    androidScheme: "https",
  },
  ios: {
    scheme: "Travel",
  },
  plugins: {
    LocationPlugin: {
      source: "ios/App/App/LocationPlugin.swift",
    },
  }
};

export default config;

/// <reference types="@capacitor/background-runner" />
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.travel.app",
  appName: "Travel",
  webDir: "out",
  server: {
    androidScheme: "https",
  },
  ios: {
    scheme: "Travel",
  },
  plugins: {
    BackgroundRunner: {
      label: "com.travel.app.uploadLocations",
      src: "runners/background.js",
      event: "uploadPendingLocations",
      repeat: true,
      interval: 5,
      autoStart: true,
    },
  },
};

export default config;

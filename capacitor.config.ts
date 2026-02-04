/// <reference types="@capacitor/background-runner" />
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
    BackgroundRunner: {
      label: "com.jeethtravel.app.uploadLocations",
      src: "runners/background.js",
      event: "uploadPendingLocations",
      repeat: true, // reschedule 5 min after each run
      interval: 5, // minutes between runs (earliestBeginDate)
      autoStart: true,
    },
  },
};

export default config;

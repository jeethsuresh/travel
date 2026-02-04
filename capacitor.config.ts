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
      repeat: true, // reschedule after each run
      interval: 1, // minutes between runs (earliestBeginDate; iOS may run less often)
      autoStart: true,
    },
  },
};

export default config;

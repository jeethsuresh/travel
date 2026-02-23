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
  // Minimal BackgroundRunner config so the plugin does not throw noRunnerConfig when app enters background.
  // autoStart: false prevents the plugin from scheduling the JS runner; only native Swift BackgroundLocationTask runs.
  plugins: {
    BackgroundRunner: {
      label: "com.jeethtravel.app.uploadLocations",
      src: "runners/background.js",
      event: "uploadPendingLocations",
      repeat: false,
      autoStart: false,
      interval: 1,
    },
  },
};

export default config;

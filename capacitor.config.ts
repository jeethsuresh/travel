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
};

export default config;

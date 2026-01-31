/**
 * Capacitor native platform detection and helpers.
 * Use these to branch between web and native (iOS) behavior.
 */

import { Capacitor } from "@capacitor/core";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function getPlatform(): "ios" | "android" | "web" {
  return Capacitor.getPlatform() as "ios" | "android" | "web";
}

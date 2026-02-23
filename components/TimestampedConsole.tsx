"use client";

import { useEffect } from "react";
import { installTimestampedConsole } from "@/lib/timestampedConsole";

/**
 * Installs timestamped console (log/warn/error/info/debug) once on client mount.
 * Renders nothing.
 */
export function TimestampedConsole() {
  useEffect(() => {
    installTimestampedConsole();
  }, []);
  return null;
}

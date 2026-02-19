"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

const LIGHT_COLOR = "#ffffff";
const DARK_COLOR = "#0a0a0a";

export function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", resolvedTheme === "dark" ? DARK_COLOR : LIGHT_COLOR);
    } else {
      const el = document.createElement("meta");
      el.name = "theme-color";
      el.content = resolvedTheme === "dark" ? DARK_COLOR : LIGHT_COLOR;
      document.head.appendChild(el);
    }
  }, [resolvedTheme]);

  return null;
}

const fs = require("fs");
const path = require("path");

const outDir = path.join(process.cwd(), "out");
const distDir = path.join(process.cwd(), "dist");

if (!fs.existsSync(outDir)) {
  console.error("scripts/copy-out-to-dist: 'out' directory not found. Run a static export build first (e.g. npm run build:native).");
  process.exit(1);
}

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}
fs.cpSync(outDir, distDir, { recursive: true });
console.log("Copied out/ → dist/");

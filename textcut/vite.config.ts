import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths: the built dist/ works from any sub-path (GitHub Pages,
  // an S3 bucket, a folder on a static host) without reconfiguration.
  base: "./",
  // @ffmpeg/ffmpeg spawns its own worker via `new URL(…, import.meta.url)`;
  // pre-bundling breaks that, so let Vite serve it as-is.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  build: { target: "es2022", sourcemap: true },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths: the built dist/ works from any sub-path (GitHub Pages,
  // an S3 bucket, a folder on a static host) without reconfiguration.
  base: "./",
  build: { target: "es2022", sourcemap: true },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});

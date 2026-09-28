// Runinback — unit tests. Kept separate from vite.config.js because the app
// build is rooted at src/ while tests live in tests/.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@game-rules": resolve(import.meta.dirname, "supabase/functions/_shared/game-rules") },
  },
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
  },
});

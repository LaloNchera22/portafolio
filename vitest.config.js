// Runinback — unit tests. Kept separate from vite.config.js because the app
// build is rooted at src/ while tests live in tests/.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

const live = process.env.IASO_LIVE === "1";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live tests call real provider APIs and cost money: opt in with IASO_LIVE=1.
    exclude: live ? ["node_modules/**"] : ["node_modules/**", "test/live/**"],
  },
});

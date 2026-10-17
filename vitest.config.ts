import { defineConfig } from "vitest/config";

const live = process.env.IASO_LIVE === "1";
const docker = process.env.IASO_DOCKER === "1";
const net = process.env.IASO_NET === "1";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      // Live tests call real provider APIs and cost money: opt in with IASO_LIVE=1.
      ...(live ? [] : ["test/live/**"]),
      // Integration tests need a running Docker daemon: opt in with IASO_DOCKER=1.
      ...(docker ? [] : ["test/integration/**"]),
      // Net tests talk to github.com: opt in with IASO_NET=1.
      ...(net ? [] : ["test/net/**"]),
    ],
  },
});

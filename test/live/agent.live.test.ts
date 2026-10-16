import { describe, expect, it } from "vitest";
import { hasApiKey } from "../../src/models.js";
import { createProvider } from "../../src/providers/registry.js";
import { runOnFixture } from "../helpers/fixture-run.js";

/**
 * A real model fixes the planted bug in a real sandbox. Costs cents (budget capped at $0.50).
 * Needs Docker and a key: IASO_LIVE=1 IASO_DOCKER=1 ANTHROPIC_API_KEY=... npx vitest run test/live/agent
 */
const MODEL = process.env.IASO_LIVE_AGENT_MODEL ?? "anthropic:claude-haiku-5-5";
const provider = MODEL.split(":")[0] as Parameters<typeof hasApiKey>[0];

describe.skipIf(!hasApiKey(provider) || process.env.IASO_DOCKER !== "1")(
  `live agent: ${MODEL}`,
  () => {
    it("fixes the off-by-one and leaves the suite green", { timeout: 10 * 60_000 }, async () => {
      const run = await runOnFixture(createProvider(MODEL), MODEL, "live");
      console.log(
        `status=${run.result.status} steps=${String(run.result.steps)} cost=$${run.result.costUsd.toFixed(4)}\n` +
          `trajectory: ${run.trajectoryPath}\n${run.result.diff}`,
      );
      expect(run.result.status).toBe("submitted");
      expect(run.testExitCode).toBe(0);
      expect(run.result.diff).toMatch(/i <= end|end \+ 1/);
    });
  },
);

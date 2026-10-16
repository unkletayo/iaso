import { describe, expect, it } from "vitest";
import { hasApiKey } from "../../src/models.js";
import { createProvider } from "../../src/providers/registry.js";
import { runPipelineOnFixture } from "../helpers/fixture-run.js";

/**
 * A real model plans, then fixes the planted bug, in a real sandbox. Costs cents (capped at $0.50).
 * Needs Docker and a key: IASO_LIVE=1 IASO_DOCKER=1 ANTHROPIC_API_KEY=... npx vitest run test/live/pipeline
 */
const MODEL = process.env.IASO_LIVE_AGENT_MODEL ?? "anthropic:claude-haiku-5-5";
const provider = MODEL.split(":")[0] as Parameters<typeof hasApiKey>[0];

describe.skipIf(!hasApiKey(provider) || process.env.IASO_DOCKER !== "1")(
  `live pipeline: ${MODEL}`,
  () => {
    it("plans and fixes the off-by-one", { timeout: 15 * 60_000 }, async () => {
      const run = await runPipelineOnFixture(createProvider(MODEL), MODEL, "live-pipeline");
      const { result } = run;
      console.log(
        `status=${result.status} plan steps=${String(result.planSteps)} total steps=${String(result.steps)} cost=$${result.costUsd.toFixed(4)}\n` +
          `run folder: ${run.runDir}\n${JSON.stringify(result.plan, null, 2)}\n${result.diff}`,
      );
      expect(result.status).toBe("submitted");
      expect(result.plan?.filesToChange.some((f) => f.path.includes("range"))).toBe(true);
      expect(run.testExitCode).toBe(0);
      expect(result.diff).toMatch(/i <= end|end \+ 1/);
    });
  },
);

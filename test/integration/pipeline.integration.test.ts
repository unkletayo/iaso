import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeReplay } from "../../src/commands/replay.js";
import { MockProvider, mockToolCall } from "../../src/providers/mock.js";
import { runPipelineOnFixture } from "../helpers/fixture-run.js";

/**
 * Plan phase, then fix phase, against a real sandbox with a scripted model. Free.
 * Opt in with: IASO_DOCKER=1 npx vitest run test/integration/pipeline
 */
const enabled = process.env.IASO_DOCKER === "1";
const MODEL = "anthropic:claude-haiku-5-5";

const planCalls = [
  mockToolCall("p1", "bash", { cmd: "cat src/range.js" }),
  mockToolCall("p2", "submit_plan", {
    rootCauseHypothesis: "sumRange loops with i < end, so the last value is skipped",
    filesToChange: [{ path: "src/range.js", change: "use <= in the loop" }],
    testPlan: "add a test for sumRange(1, 5) === 15, run node --test",
    risks: [],
    steps: ["add the failing test", "change the loop bound", "run the suite"],
  }),
];

const fixCalls = [
  mockToolCall("c1", "edit_file", {
    path: "test/range.test.js",
    oldText: 'test("sumRange of a single value is that value", () => {',
    newText:
      'test("sumRange includes both ends", () => {\n  assert.equal(sumRange(1, 5), 15);\n});\n\ntest("sumRange of a single value is that value", () => {',
  }),
  mockToolCall("c2", "edit_file", {
    path: "src/range.js",
    oldText: "i < end;",
    newText: "i <= end;",
  }),
  mockToolCall("c3", "bash", { cmd: "node --test 2>&1 | grep -E '^# (pass|fail)'" }),
  mockToolCall("c4", "submit", {
    summary: "sumRange stopped before `end`. Loop now uses <=.",
    prTitle: "Include the end value in sumRange",
    prSummary: "sumRange stopped before end. The loop now uses <=.",
    assumptions: [],
    testsAdded: ["test/range.test.js"],
    confidence: "high",
  }),
];

describe.skipIf(!enabled)("pipeline end to end (real Docker, scripted model)", () => {
  it(
    "plans, fixes with the plan pinned, and can be replayed",
    { timeout: 10 * 60_000 },
    async () => {
      const provider = new MockProvider([...planCalls, ...fixCalls], MODEL);
      const run = await runPipelineOnFixture(provider, MODEL, "e2e-pipeline");
      const { result } = run;
      expect(result.status).toBe("submitted");
      expect(result.plan?.filesToChange[0]?.path).toBe("src/range.js");
      expect(result.planSteps).toBe(planCalls.length);
      expect(result.steps).toBe(planCalls.length + fixCalls.length);
      expect(run.testExitCode).toBe(0);
      expect(result.diff).toContain("i <= end");

      // The fix phase got the approved plan in its first request.
      const firstFix = provider.requests[planCalls.length];
      const pinned = JSON.stringify(firstFix?.messages[0]?.content);
      expect(pinned).toContain("## Approved plan");
      expect(pinned).toContain("use <= in the loop");

      // The run folder has what replay needs.
      expect(await readFile(join(run.runDir, "issue.md"), "utf8")).toContain("sumRange");
      const lines: string[] = [];
      await executeReplay(basename(run.runDir), { runs: dirname(run.runDir), context: 3 }, (l) =>
        lines.push(l),
      );
      expect(lines.join("\n")).toContain("## Approved plan");
      expect(lines.join("\n")).toContain("edit_file");
    },
  );
});

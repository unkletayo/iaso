import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Budget } from "../../src/agent/budget.js";
import { BUDGET_DEFAULTS } from "../../src/config.js";
import { MockProvider, mockToolCall } from "../../src/providers/mock.js";
import { runOnFixture } from "../helpers/fixture-run.js";

/**
 * The whole loop against a real sandbox, with a scripted model. Free.
 * Opt in with: IASO_DOCKER=1 npx vitest run test/integration/agent
 */
const enabled = process.env.IASO_DOCKER === "1";
const MODEL = "anthropic:claude-haiku-5-5";

const script = [
  mockToolCall("c1", "bash", { cmd: "cat src/range.js && node --test 2>&1 | tail -5" }),
  mockToolCall("c2", "edit_file", {
    path: "test/range.test.js",
    oldText: 'test("sumRange of a single value is that value", () => {',
    newText:
      'test("sumRange includes both ends", () => {\n  assert.equal(sumRange(1, 5), 15);\n});\n\ntest("sumRange of a single value is that value", () => {',
  }),
  mockToolCall("c3", "bash", { cmd: "node --test 2>&1 | grep -E '^# (pass|fail)|not ok'" }),
  mockToolCall("c4", "edit_file", {
    path: "src/range.js",
    oldText: "i < end;",
    newText: "i <= end;",
  }),
  mockToolCall("c5", "bash", { cmd: "node --test 2>&1 | grep -E '^# (pass|fail)'" }),
  mockToolCall("c6", "submit", {
    summary: "sumRange stopped before `end`. Loop now uses <=.",
    testsAdded: ["test/range.test.js"],
    confidence: "high",
  }),
];

describe.skipIf(!enabled)("agent loop end to end (real Docker, scripted model)", () => {
  it("fixes the planted off-by-one and submits", { timeout: 10 * 60_000 }, async () => {
    const run = await runOnFixture(
      new MockProvider(script, MODEL),
      MODEL,
      "e2e-mock",
      new Budget(BUDGET_DEFAULTS),
    );
    expect(run.result.status).toBe("submitted");
    expect(run.result.diff).toContain("i <= end");
    expect(run.result.diff).toContain("sumRange includes both ends");
    expect(run.testExitCode).toBe(0);
    const lines = (await readFile(run.trajectoryPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(script.length);
  });
});

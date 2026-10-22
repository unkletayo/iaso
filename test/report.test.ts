import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PipelineResult } from "../src/agent/pipeline.js";
import { renderReport, writeReport } from "../src/agent/report.js";
import { emptyTaskState } from "../src/context/state.js";

const base: PipelineResult = {
  status: "submitted",
  planCostUsd: 0.01,
  planSteps: 2,
  costUsd: 0.0234,
  steps: 9,
  diff: "--- a/x\n+++ b/x\n@@\n-a\n+b\n",
  plan: {
    rootCauseHypothesis: "off by one",
    filesToChange: [{ path: "x", change: "fix" }],
    testPlan: "t",
    risks: [],
    steps: ["do it"],
  },
  fix: {
    status: "submitted",
    steps: 7,
    compactions: 0,
    costUsd: 0.0134,
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    submission: {
      summary: "Fixed the loop.",
      prTitle: "Fix the loop",
      prSummary: "The loop stopped early.",
      assumptions: [],
      testsAdded: ["t.js"],
      confidence: "high",
      step: 7,
    },
    state: {
      ...emptyTaskState(),
      testsRun: [{ cmd: "node --test", result: "pass", step: 6 }],
      failedApproaches: [{ what: "swap args", whyItFailed: "wrong side" }],
    },
    diff: "",
  },
};
const input = { runId: "r1", issue: "bug text", model: "m", elapsedMs: 12_345, result: base };

describe("renderReport", () => {
  it("has plan, diff, tests, cost and step count", () => {
    const md = renderReport(input);
    expect(md).toContain("status: submitted");
    expect(md).toContain("steps: 9 (plan 2)");
    expect(md).toContain("cost: $0.0234 (plan $0.0100)");
    expect(md).toContain("time: 12.3s");
    expect(md).toContain("root cause hypothesis: off by one");
    expect(md).toContain("[pass] node --test (step 6)");
    expect(md).toContain("- swap args: wrong side");
    expect(md).toContain("Fixed the loop.");
    expect(md).toMatch(/```diff\n--- a\/x/);
  });

  it("shows the PR text and the assumptions the agent gave", () => {
    const { fix } = base;
    if (fix?.submission === undefined) throw new Error("fixture has no submission");
    const submission = { ...fix.submission, assumptions: ["Empty range gives 0."] };
    const md = renderReport({ ...input, result: { ...base, fix: { ...fix, submission } } });
    expect(md).toContain("title: Fix the loop");
    expect(md).toContain("The loop stopped early.");
    expect(md).toContain("## Assumptions\n\n- Empty range gives 0.");
  });

  it("names the source when there is one, and leaves the line out when there is not", () => {
    expect(renderReport(input)).not.toContain("- source:");
    const md = renderReport({
      ...input,
      source: {
        label: "acme/widgets#7",
        issueUrl: "https://github.com/acme/widgets/issues/7",
        commit: "abc123",
      },
    });
    expect(md).toContain(
      "- source: acme/widgets#7 (https://github.com/acme/widgets/issues/7), commit abc123",
    );
    expect(renderReport({ ...input, source: { label: "/work/repo" } })).toContain(
      "- source: /work/repo\n",
    );
  });

  it("reports a run that stopped in the plan phase", () => {
    const rest: PipelineResult = { ...base };
    delete rest.fix;
    delete rest.plan;
    const md = renderReport({
      ...input,
      result: {
        ...rest,
        status: "plan_rejected",
        message: "no",
        diff: "",
      },
    });
    expect(md).toContain("status: plan_rejected (no)");
    expect(md).toContain("(no plan: skipped or not produced)");
    expect(md).toContain("(no changes)");
    expect(md).not.toContain("## Tests run");
  });

  it("uses a longer fence when the diff contains backticks", () => {
    const md = renderReport({ ...input, result: { ...base, diff: "+```js\n+x\n+```\n" } });
    expect(md).toContain("````diff");
  });
});

describe("writeReport", () => {
  it("writes report.md and patch.diff", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "iaso-report-")), "run");
    await writeReport(dir, input);
    expect(await readFile(join(dir, "report.md"), "utf8")).toContain("# Iaso report: r1");
    expect(await readFile(join(dir, "patch.diff"), "utf8")).toBe(base.diff);
  });
});

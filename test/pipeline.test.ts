import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PipelineOptions,
  type PlanReviewer,
  runPipeline,
  runPlanPhase,
} from "../src/agent/pipeline.js";
import { BUDGET_DEFAULTS } from "../src/config.js";
import type { Plan } from "../src/context/state.js";
import { MockProvider, type ScriptedStep, mockText, mockToolCall } from "../src/providers/mock.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const prices = { inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3 };
const plan: Plan = {
  rootCauseHypothesis: "off by one",
  filesToChange: [{ path: "src/a.js", change: "use <=" }],
  testPlan: "add a test",
  risks: [],
  steps: ["fix"],
};
const submit = mockToolCall("s", "submit", { summary: "done", testsAdded: [], confidence: "high" });

let runDir = "";
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "iaso-pipeline-"));
});

function setup(script: ScriptedStep[], over: Partial<PipelineOptions> = {}) {
  const provider = new MockProvider(script);
  const fake = fakeSandbox();
  const options: PipelineOptions = {
    fix: { provider, prices },
    sandbox: fake.sandbox,
    issue: "ISSUE",
    limits: BUDGET_DEFAULTS,
    runDir,
    usePlan: true,
    ...over,
  };
  return { provider, options };
}

describe("runPipeline", () => {
  it("plans, then fixes with the plan pinned, and adds the costs", async () => {
    const s = setup([mockToolCall("p", "submit_plan", plan), submit]);
    const res = await runPipeline(s.options);
    expect(res.status).toBe("submitted");
    expect(res.plan).toEqual(plan);
    expect(res.steps).toBe(2);
    expect(res.planSteps).toBe(1);
    expect(res.costUsd).toBeCloseTo(res.planCostUsd + (res.fix?.costUsd ?? 0));
    const fixRequest = JSON.stringify(s.provider.requests[1]?.messages[0]);
    expect(fixRequest).toContain("Approved plan");
    expect(fixRequest).toContain("off by one");
    expect(s.provider.requests[1]?.tools.map((t) => t.name)).toContain("edit_file");
    expect(s.provider.requests[0]?.tools.map((t) => t.name)).not.toContain("edit_file");
    expect(JSON.parse(await readFile(join(runDir, "plan.json"), "utf8"))).toEqual(plan);
  });

  it("skips the plan phase when asked", async () => {
    const s = setup([submit], { usePlan: false });
    const res = await runPipeline(s.options);
    expect(res.status).toBe("submitted");
    expect(res.plan).toBeUndefined();
    expect(res.planSteps).toBe(0);
    expect(JSON.stringify(s.provider.requests[0]?.messages[0])).not.toContain("Approved plan");
  });

  it("uses the plan model for planning and the fix model for fixing", async () => {
    const planProvider = new MockProvider([mockToolCall("p", "submit_plan", plan)], "mock:plan");
    const fixProvider = new MockProvider([submit], "mock:fix");
    const s = setup([], {
      fix: { provider: fixProvider, prices },
      plan: { provider: planProvider, prices },
    });
    const res = await runPipeline(s.options);
    expect(res.status).toBe("submitted");
    expect(planProvider.callCount).toBe(1);
    expect(fixProvider.callCount).toBe(1);
  });

  it("stops with plan_failed when no plan comes back", async () => {
    const s = setup([mockText("no"), mockText("no")]);
    const res = await runPipeline(s.options);
    expect(res.status).toBe("plan_failed");
    expect(res.fix).toBeUndefined();
    expect(s.provider.callCount).toBe(2);
  });

  it("stops with plan_rejected and never starts the fix", async () => {
    const review: PlanReviewer = () => Promise.resolve({ kind: "reject" });
    const s = setup([mockToolCall("p", "submit_plan", plan)], { review });
    const res = await runPipeline(s.options);
    expect(res.status).toBe("plan_rejected");
    expect(res.fix).toBeUndefined();
    expect(s.provider.callCount).toBe(1);
  });

  it("gives the fix phase only the cost left after planning", async () => {
    const s = setup([mockToolCall("p", "submit_plan", plan), submit], {
      limits: { ...BUDGET_DEFAULTS, maxCostUsd: 0.00001 },
    });
    const res = await runPipeline(s.options);
    // The plan call alone costs more than the limit, so the fix phase has nothing left.
    expect(res.status).toBe("budget_exceeded");
    expect(res.steps).toBe(1);
  });
});

describe("runPlanPhase: review rounds", () => {
  it("revises once on feedback, then accepts", async () => {
    const revised = { ...plan, rootCauseHypothesis: "revised" };
    const review = vi
      .fn<PlanReviewer>()
      .mockResolvedValueOnce({ kind: "feedback", text: "check negatives" })
      .mockResolvedValueOnce({ kind: "approve" });
    const s = setup(
      [mockToolCall("p1", "submit_plan", plan), mockToolCall("p2", "submit_plan", revised)],
      {
        review,
      },
    );
    const stage = await runPlanPhase(s.options);
    expect(stage).toMatchObject({ ok: true, plan: revised, steps: 2 });
    expect(review.mock.calls.map((c) => c[1])).toEqual([true, false]);
    expect(JSON.stringify(s.provider.requests[1]?.messages[0])).toContain("check negatives");
  });

  it("treats feedback on the last round as a rejection", async () => {
    const review = vi.fn<PlanReviewer>().mockResolvedValue({ kind: "feedback", text: "again" });
    const s = setup(
      [mockToolCall("p1", "submit_plan", plan), mockToolCall("p2", "submit_plan", plan)],
      {
        review,
      },
    );
    const stage = await runPlanPhase(s.options);
    expect(stage).toMatchObject({ ok: false, status: "plan_rejected" });
    expect(review).toHaveBeenCalledTimes(2);
  });
});

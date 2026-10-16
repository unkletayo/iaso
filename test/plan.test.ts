import { describe, expect, it } from "vitest";
import { Budget } from "../src/agent/budget.js";
import { PLAN_PROMPT, type PlanOptions, renderPlan, runPlan } from "../src/agent/plan.js";
import { BUDGET_DEFAULTS } from "../src/config.js";
import type { Plan } from "../src/context/state.js";
import { MockProvider, type ScriptedStep, mockText, mockToolCall } from "../src/providers/mock.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const prices = { inputPrice: 1, outputPrice: 5, cachedInputPrice: 0.1 };

const goodPlan: Plan = {
  rootCauseHypothesis: "loop stops one short",
  filesToChange: [{ path: "src/range.js", change: "use <=" }],
  testPlan: "add sumRange(1,5) === 15",
  risks: ["none"],
  steps: ["write test", "fix loop"],
};

function setup(script: ScriptedStep[], over: Partial<PlanOptions> = {}) {
  const provider = new MockProvider(script);
  const fake = fakeSandbox();
  const options: PlanOptions = {
    provider,
    prices,
    sandbox: fake.sandbox,
    issue: "ISSUE",
    budget: new Budget(BUDGET_DEFAULTS),
    ...over,
  };
  return { provider, fake, run: () => runPlan(options) };
}

describe("runPlan", () => {
  it("ends when the model submits a valid plan", async () => {
    const s = setup([
      mockToolCall("c1", "bash", { cmd: "ls" }),
      mockToolCall("c2", "submit_plan", goodPlan),
    ]);
    const res = await s.run();
    expect(res.plan).toEqual(goodPlan);
    expect(res.result.status).toBe("submitted");
    expect(res.result.steps).toBe(2);
  });

  it("offers only read tools and the plan prompt", async () => {
    const s = setup([mockToolCall("c1", "submit_plan", goodPlan)]);
    await s.run();
    const req = s.provider.requests[0];
    expect(req?.system).toBe(PLAN_PROMPT);
    expect(req?.tools.map((t) => t.name).sort()).toEqual(["bash", "read_file", "submit_plan"]);
  });

  it("lets the model fix an invalid plan and try again", async () => {
    const s = setup([
      mockToolCall("c1", "submit_plan", { ...goodPlan, steps: [] }),
      mockToolCall("c2", "submit_plan", goodPlan),
    ]);
    const res = await s.run();
    expect(res.plan).toEqual(goodPlan);
    expect(res.result.steps).toBe(2);
  });

  it("refuses a write command and does not run it", async () => {
    const s = setup([
      mockToolCall("c1", "bash", { cmd: "echo x > a.txt" }),
      mockToolCall("c2", "submit_plan", goodPlan),
    ]);
    await s.run();
    expect(s.fake.exec).not.toHaveBeenCalled();
    const results = s.provider.requests[1]?.messages.at(-1)?.content ?? [];
    expect(JSON.stringify(results)).toContain("Command refused");
  });

  it("returns no plan when the model gives up", async () => {
    const s = setup([mockText("I cannot."), mockText("Still cannot.")]);
    const res = await s.run();
    expect(res.plan).toBeUndefined();
    expect(res.result.status).toBe("no_tool_use");
  });

  it("puts the previous plan and the feedback in the issue for a second round", async () => {
    const s = setup([mockToolCall("c1", "submit_plan", goodPlan)], {
      feedback: { previous: goodPlan, text: "also cover negative ranges" },
    });
    await s.run();
    const first = JSON.stringify(s.provider.requests[0]?.messages[0]);
    expect(first).toContain("also cover negative ranges");
    expect(first).toContain("loop stops one short");
  });
});

describe("renderPlan", () => {
  it("numbers the steps and lists the files", () => {
    const text = renderPlan(goodPlan);
    expect(text).toContain("1. write test");
    expect(text).toContain("src/range.js: use <=");
  });
});

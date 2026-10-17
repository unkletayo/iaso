import { describe, expect, it } from "vitest";
import { newRunState } from "../src/context/state.js";
import { runTool } from "../src/tools/schema.js";
import { submitPlanTool } from "../src/tools/submit-plan.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const plan = {
  rootCauseHypothesis: "h",
  filesToChange: [{ path: "a.ts", change: "c" }],
  testPlan: "t",
  risks: [],
  steps: ["s"],
};

describe("submit_plan", () => {
  it("records the plan in the run state", async () => {
    const run = newRunState();
    const res = await runTool(submitPlanTool, plan, {
      sandbox: fakeSandbox().sandbox,
      step: 3,
      run,
    });
    expect(res.isError).toBe(false);
    expect(run.plan).toEqual(plan);
  });

  it("takes a plan without risks and records none", async () => {
    const run = newRunState();
    const withoutRisks = {
      rootCauseHypothesis: plan.rootCauseHypothesis,
      filesToChange: plan.filesToChange,
      testPlan: plan.testPlan,
      steps: plan.steps,
    };
    const res = await runTool(submitPlanTool, withoutRisks, {
      sandbox: fakeSandbox().sandbox,
      step: 2,
      run,
    });
    expect(res.isError).toBe(false);
    expect(run.plan?.risks).toEqual([]);
  });

  it("names the fields that are missing", async () => {
    const run = newRunState();
    const res = await runTool(
      submitPlanTool,
      { rootCauseHypothesis: "h", testPlan: "t", steps: ["s"] },
      { sandbox: fakeSandbox().sandbox, step: 1, run },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("filesToChange");
    expect(res.output).toContain("risks (optional)");
    expect(run.plan).toBeUndefined();
  });

  it("rejects an empty steps list", async () => {
    const run = newRunState();
    const res = await runTool(
      submitPlanTool,
      { ...plan, steps: [] },
      { sandbox: fakeSandbox().sandbox, step: 1, run },
    );
    expect(res.isError).toBe(true);
    expect(run.plan).toBeUndefined();
  });

  it("rejects a second plan", async () => {
    const run = newRunState();
    const ctx = { sandbox: fakeSandbox().sandbox, step: 1, run };
    await runTool(submitPlanTool, plan, ctx);
    const again = await runTool(submitPlanTool, { ...plan, testPlan: "other" }, ctx);
    expect(again.isError).toBe(true);
    expect(run.plan?.testPlan).toBe("t");
  });
});

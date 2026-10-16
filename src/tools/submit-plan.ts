import { planSchema } from "../context/state.js";
import { type Tool, defineTool } from "./schema.js";

export const submitPlanDefinition = defineTool({
  name: "submit_plan",
  description:
    "Finish the plan phase. Call it once, after you have read the relevant code and tests. " +
    "rootCauseHypothesis: what you think is wrong and why. filesToChange: each file and the " +
    "change it needs. testPlan: the failing test you will write and the existing tests to run. " +
    "risks: what could go wrong. steps: the ordered steps of the fix.",
  input: planSchema,
});

export const submitPlanTool: Tool<typeof submitPlanDefinition.input> = {
  definition: submitPlanDefinition,
  run(input, { run }) {
    if (!run)
      return Promise.resolve({
        output: "submit_plan is not available in this run.",
        isError: true,
      });
    if (run.plan) return Promise.resolve({ output: "Plan already submitted.", isError: true });
    run.plan = input;
    return Promise.resolve({ output: "Plan recorded. The plan phase is ending.", isError: false });
  },
};

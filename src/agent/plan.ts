import type { Plan } from "../context/state.js";
import { type LoopOptions, type LoopResult, runLoop } from "./loop.js";
import { readFileTool } from "../tools/read-file.js";
import { readOnlyBashTool } from "../tools/readonly-bash.js";
import { submitPlanTool } from "../tools/submit-plan.js";

/** Bump on any change to the plan prompt. */
export const PLAN_PROMPT_VERSION = "1.0.0";

/** Spec §8 phase 1. */
export const PLAN_PROMPT = `You are an expert software engineer planning a bug fix in the repository at /repo.

This is the plan phase. You cannot change files. You can read them (read_file, and a read-only bash) and you must end by calling submit_plan.

Work in this order:
1. Read the issue. It is the source of truth for expected behaviour.
2. Explore the repo. Find the code the issue points to and the existing tests that cover it.
3. Form a root cause hypothesis and check it against the code. Use tools for every claim. Do not guess file contents.
4. Call submit_plan with: rootCauseHypothesis, filesToChange, testPlan (the failing test you will write, and which existing tests to run), risks, and steps.

Keep the plan small. Plan the smallest correct change. Do not plan refactors the issue does not ask for.`;

export interface PlanOptions extends Omit<LoopOptions, "tools" | "systemPrompt" | "plan"> {
  /** Reviewer feedback on an earlier plan. Triggers one more round. */
  feedback?: { previous: Plan; text: string };
}

export interface PlanResult {
  /** Absent when the model never called submit_plan (see `result.status`). */
  plan?: Plan;
  result: LoopResult;
}

export function renderPlan(plan: Plan): string {
  const list = (items: string[]): string =>
    items.length === 0 ? "(none)" : items.map((i) => `- ${i}`).join("\n");
  return [
    `root cause hypothesis: ${plan.rootCauseHypothesis}`,
    `files to change:\n${list(plan.filesToChange.map((f) => `${f.path}: ${f.change}`))}`,
    `test plan: ${plan.testPlan}`,
    `risks:\n${list(plan.risks)}`,
    `steps:\n${plan.steps.map((s, i) => `${String(i + 1)}. ${s}`).join("\n")}`,
  ].join("\n");
}

/** Run the plan phase: a read-only loop that ends when the model submits a plan. */
export async function runPlan({ feedback, ...opts }: PlanOptions): Promise<PlanResult> {
  const issue = feedback
    ? `${opts.issue}\n\n## Your previous plan\n\n${renderPlan(feedback.previous)}\n\n## Reviewer feedback\n\n${feedback.text}\n\nRevise the plan to address the feedback, then call submit_plan.`
    : opts.issue;
  const result = await runLoop({
    ...opts,
    issue,
    systemPrompt: PLAN_PROMPT,
    tools: [readOnlyBashTool, readFileTool, submitPlanTool],
  });
  return { ...(result.plan ? { plan: result.plan } : {}), result };
}

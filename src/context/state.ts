import { z } from "zod";

/** Spec §7A point 3: the agent's structured notes. They survive every compaction in full. */
export interface TaskState {
  phase: "plan" | "reproduce" | "fix" | "verify" | "report";
  rootCauseHypothesis: string;
  /** Each entry ends with "(step N)", the step that proved it. */
  confirmedFacts: string[];
  filesExamined: { path: string; why: string }[];
  failedApproaches: { what: string; whyItFailed: string }[];
  testsRun: { cmd: string; result: "pass" | "fail"; step: number }[];
  todo: string[];
}

const phase = z.enum(["plan", "reproduce", "fix", "verify", "report"]);

/**
 * What the agent sends to the `notes` tool. `step` is not part of it: the tool stamps it, so the
 * agent cannot forget or forge it.
 */
export const taskStatePatchSchema = z.strictObject({
  phase: phase.optional(),
  rootCauseHypothesis: z.string().optional(),
  confirmedFacts: z.array(z.string().min(1)).optional(),
  filesExamined: z.array(z.strictObject({ path: z.string().min(1), why: z.string() })).optional(),
  failedApproaches: z
    .array(z.strictObject({ what: z.string().min(1), whyItFailed: z.string() }))
    .optional(),
  testsRun: z
    .array(z.strictObject({ cmd: z.string().min(1), result: z.enum(["pass", "fail"]) }))
    .optional(),
  todo: z.array(z.string()).optional(),
});

export type TaskStatePatch = z.infer<typeof taskStatePatchSchema>;

export function emptyTaskState(phase: TaskState["phase"] = "plan"): TaskState {
  return {
    phase,
    rootCauseHypothesis: "",
    confirmedFacts: [],
    filesExamined: [],
    failedApproaches: [],
    testsRun: [],
    todo: [],
  };
}

/** Spec §8 phase 1: what the planner hands over. */
export const planSchema = z.strictObject({
  rootCauseHypothesis: z.string().min(1),
  filesToChange: z.array(z.strictObject({ path: z.string().min(1), change: z.string().min(1) })),
  testPlan: z.string().min(1),
  // Optional: a small model that leaves it out should not lose the whole plan.
  risks: z.array(z.string().min(1)).default([]),
  steps: z.array(z.string().min(1)).min(1),
});

export type Plan = z.infer<typeof planSchema>;

/** What `submit` records. The loop (4F) sees it and ends the run. */
export interface Submission {
  summary: string;
  /** One line that describes the change (not the bug report), for a pull request title. */
  prTitle: string;
  /** What changed and why, written for a maintainer who has not seen the run. */
  prSummary: string;
  /** Where the issue left the expected behaviour open and the agent chose. */
  assumptions: string[];
  testsAdded: string[];
  confidence: "low" | "medium" | "high";
  step: number;
}

/** Mutable per-run state the tools share. The loop owns one and passes it in `ToolContext`. */
export interface RunState {
  task: TaskState;
  /** Step of the last accepted `notes` call; 0 if none yet. Drives the 8-step nudge. */
  lastNotesStep: number;
  submission?: Submission;
  /** Set by `submit_plan` in the plan phase. The loop ends the run when it appears. */
  plan?: Plan;
}

export function newRunState(phase?: TaskState["phase"]): RunState {
  return { task: emptyTaskState(phase), lastNotesStep: 0 };
}

const STEP_SUFFIX = / \(step \d+\)$/;

const stampFact = (fact: string, step: number): string => `${fact} (step ${String(step)})`;

/** Append items whose key is new; an existing key keeps its place but takes the newer value. */
function upsertBy<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const result = [...existing];
  for (const item of incoming) {
    const at = result.findIndex((r) => key(r) === key(item));
    if (at === -1) result.push(item);
    else result[at] = item;
  }
  return result;
}

/** Stamp new facts with the step. A repeated fact keeps its original step: that is when it was proven. */
function addFacts(existing: string[], incoming: string[], step: number): string[] {
  const bare = (fact: string): string => fact.replace(STEP_SUFFIX, "");
  const result = [...existing];
  for (const fact of incoming) {
    if (!result.some((e) => bare(e) === bare(fact))) result.push(stampFact(bare(fact), step));
  }
  return result;
}

/**
 * Merge a patch into the state without mutating either.
 * - phase, rootCauseHypothesis, todo: replaced (todo must shrink as items are done).
 * - the other lists only grow, so the agent cannot erase failedApproaches by accident.
 */
export function mergeTaskState(state: TaskState, patch: TaskStatePatch, step: number): TaskState {
  return {
    phase: patch.phase ?? state.phase,
    rootCauseHypothesis: patch.rootCauseHypothesis ?? state.rootCauseHypothesis,
    confirmedFacts: addFacts(state.confirmedFacts, patch.confirmedFacts ?? [], step),
    filesExamined: upsertBy(state.filesExamined, patch.filesExamined ?? [], (f) => f.path),
    failedApproaches: upsertBy(state.failedApproaches, patch.failedApproaches ?? [], (f) => f.what),
    // Test runs are a history: the same command passing after failing is two entries.
    testsRun: [...state.testsRun, ...(patch.testsRun ?? []).map((t) => ({ ...t, step }))],
    todo: patch.todo ?? state.todo,
  };
}

export function isEmptyPatch(patch: TaskStatePatch): boolean {
  return Object.values(patch).every((v) => v === undefined);
}

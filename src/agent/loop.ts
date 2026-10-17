import {
  ContextMeter,
  type Thresholds,
  estimateRequestTokens,
  thresholdsFor,
} from "../context/budget.js";
import { compactSteps, splitSteps } from "../context/compaction.js";
import { DEFAULT_RECENT_STEPS, type WorkingFile, buildRequest } from "../context/layers.js";
import { LoopDetector, type Repeat } from "../context/loops.js";
import { classifyCommand, shapeOutput } from "../context/shaping.js";
import {
  type Plan,
  type RunState,
  type Submission,
  type TaskState,
  newRunState,
} from "../context/state.js";
import type {
  ChatResponse,
  ContentBlock,
  Message,
  ModelProvider,
  Usage,
} from "../providers/types.js";
import type { Sandbox } from "../sandbox/types.js";
import { CostTracker, type ModelPrices } from "../telemetry/cost.js";
import type { ContextEvent, TrajectoryStep, TrajectoryWriter } from "../telemetry/trajectory.js";
import { resolveRepoPath } from "../tools/paths.js";
import type { OutputStore } from "../tools/read-output.js";
import { type Tool, runTool, toToolDef } from "../tools/schema.js";
import { truncateOutput } from "../tools/truncate.js";
import type { Budget } from "./budget.js";
import {
  BUDGET_NUDGE_AT,
  MAX_LOOP_NUDGES,
  NOTES_NUDGE,
  NOTES_NUDGE_AFTER_STEPS,
  NO_TOOL_NUDGE,
  budgetNudge,
  PROMPT_VERSION,
  loopNudge,
} from "./prompts.js";

export type RunStatus = "submitted" | "budget_exceeded" | "no_tool_use" | "stuck" | "error";

export interface LoopOptions {
  provider: ModelProvider;
  prices: ModelPrices;
  sandbox: Sandbox;
  tools: readonly Tool[];
  systemPrompt: string;
  issue: string;
  /** The approved plan, rendered. Pinned in every request. */
  plan?: string;
  budget: Budget;
  maxOutputTokens?: number;
  /** Keep this many recent steps in full. Without it, and without compaction, all are kept. */
  recentSteps?: number | undefined;
  /** The model's context window in tokens. Enables the 50% / 25% / 85% thresholds. */
  contextWindow?: number;
  /** The model that writes summaries. Without it nothing is compacted, only trimmed at 85%. */
  compaction?: { provider: ModelProvider; prices: ModelPrices };
  trajectory?: TrajectoryWriter;
  /** Where full copies of shortened outputs go. Without it nothing is saved. */
  outputs?: OutputStore;
}

export interface LoopResult {
  status: RunStatus;
  /** Why the run ended, when it did not submit. */
  message?: string;
  steps: number;
  costUsd: number;
  usage: Usage;
  /** Successful compactions. Their cost is part of `costUsd`. */
  compactions: number;
  submission?: Submission;
  /** Set when the plan phase ended with `submit_plan`. */
  plan?: Plan;
  state: TaskState;
  /** The sandbox diff at the end, or "" if it could not be read. */
  diff: string;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

interface ExecutedCall {
  call: ToolCall;
  /** What the model sees: shaped, cut, with a pointer to the full text if it was shortened. */
  shown: string;
  /** The tool's full output, before shaping. Loop detection reads this. */
  raw: string;
  isError: boolean;
}

/** The mutable state of one run. Kept in one place so each step function stays small. */
interface Loop {
  opts: LoopOptions;
  run: RunState;
  history: Message[];
  workingSet: Map<string, string>;
  cost: CostTracker;
  meter: ContextMeter;
  steps: number;
  /** True after we nudged for a missing tool call; cleared once the model calls a tool. */
  nudgedNoTool: boolean;
  lastNotesNudgeStep: number;
  /** True once the wrap-up warning went out. It is sent at most once per run. */
  budgetWarned: boolean;
  detector: LoopDetector;
  /** Repeat warnings sent so far. One more repeat after MAX_LOOP_NUDGES ends the run. */
  loopNudges: number;
  thresholds: Thresholds | undefined;
  /** Rolling summary of the steps already dropped from `history`. */
  summary: string | undefined;
  /** Absolute number of the first step in `history`. */
  firstStep: number;
  compactions: number;
  /** Compactor spend, tracked apart from the main model because the prices differ. */
  compactCost: CostTracker | undefined;
  /** Do not try to compact again before this step (set after a failure). */
  compactAfterStep: number;
  /** Logged with the next step. */
  pendingEvents: ContextEvent[];
}

/** After a failed compaction, wait this many steps before paying for another try. */
const COMPACT_RETRY_AFTER_STEPS = 5;
/** Spec §7A point 6: at the hard limit, keep only this many recent steps. */
const HARD_LIMIT_RECENT_STEPS = 4;

const toolCallsOf = (content: ContentBlock[]): ToolCall[] =>
  content.flatMap((b) =>
    b.type === "tool_call" ? [{ id: b.id, name: b.name, input: b.input }] : [],
  );

const textOf = (content: ContentBlock[]): string =>
  content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
}

/** Shape, cut, and save the full text when anything was lost. */
async function present(
  l: Loop,
  call: ToolCall,
  raw: string,
  step: number,
  callNo: number,
): Promise<string> {
  const cmd = field(call.input, "cmd");
  const kind = call.name === "bash" && typeof cmd === "string" ? classifyCommand(cmd) : "other";
  const shaped = shapeOutput(kind, raw);
  const cut = truncateOutput(shaped.text);
  if (!shaped.shaped && cut === raw) return raw;
  if (!l.opts.outputs) return cut;
  await l.opts.outputs.save(step, callNo, raw);
  return `${cut}\n[shortened. Full output: read_output with step=${String(step)}, call=${String(callNo)}]`;
}

/** After a successful edit, remember the file's latest content for the working-set layer. */
async function trackEdit(l: Loop, call: ToolCall): Promise<void> {
  const path = field(call.input, "path");
  if (typeof path !== "string") return;
  try {
    const resolved = resolveRepoPath(path);
    l.workingSet.set(resolved, await l.opts.sandbox.readFile(resolved));
  } catch {
    // Too big to read back, or already gone: the file just stays out of the working set.
  }
}

async function execute(
  l: Loop,
  call: ToolCall,
  step: number,
  callNo: number,
): Promise<ExecutedCall> {
  const tool = l.opts.tools.find((t) => t.definition.name === call.name);
  if (!tool) {
    const known = l.opts.tools.map((t) => t.definition.name).join(", ");
    return {
      call,
      shown: `Unknown tool "${call.name}". Available tools: ${known}.`,
      raw: `Unknown tool "${call.name}". Available tools: ${known}.`,
      isError: true,
    };
  }
  const ctx = { sandbox: l.opts.sandbox, step, run: l.run };
  const result = await runTool(tool, call.input, ctx, { truncate: false });
  if (call.name === "edit_file" && !result.isError) await trackEdit(l, call);
  return {
    call,
    shown: await present(l, call, result.output, step, callNo),
    raw: result.output,
    isError: result.isError,
  };
}

/** Run the calls in order. Calls after a successful `submit` are not run. */
async function executeAll(l: Loop, calls: ToolCall[], step: number): Promise<ExecutedCall[]> {
  const done: ExecutedCall[] = [];
  for (const [i, call] of calls.entries()) {
    done.push(await execute(l, call, step, i + 1));
    if (l.run.submission ?? l.run.plan) break;
  }
  return done;
}

function resultsMessage(done: ExecutedCall[], extraText: string[]): Message {
  const results: ContentBlock[] = done.map((d) => ({
    type: "tool_result",
    id: d.call.id,
    output: d.shown,
    isError: d.isError,
  }));
  const nudges: ContentBlock[] = extraText.map((text) => ({ type: "text", text }));
  return { role: "user", content: [...results, ...nudges] };
}

/** Spec §7A point 3: nudge when the notes have not been updated for 8 steps. */
function notesNudge(l: Loop, step: number): string[] {
  const since = Math.max(l.run.lastNotesStep, l.lastNotesNudgeStep);
  if (step - since < NOTES_NUDGE_AFTER_STEPS) return [];
  l.lastNotesNudgeStep = step;
  return [NOTES_NUDGE];
}

/** Warn once when any budget limit is 80% used, so the model submits before the run is cut off. */
function budgetWarning(l: Loop, step: number): string[] {
  if (l.budgetWarned) return [];
  const use = l.opts.budget.used({ steps: step, costUsd: totalCost(l) });
  if (use.fraction < BUDGET_NUDGE_AT) return [];
  l.budgetWarned = true;
  const names = l.opts.tools.map((t) => t.definition.name);
  const submit = names.includes("submit_plan") ? "submit_plan" : "submit";
  return [budgetNudge(use.description, submit)];
}

/** Show every call to the detector (so counts stay right) and return the first repeat found. */
function findRepeat(l: Loop, done: ExecutedCall[]): Repeat | undefined {
  let first: Repeat | undefined;
  for (const d of done) {
    const repeat = l.detector.observe({
      name: d.call.name,
      input: d.call.input,
      output: d.raw,
      isError: d.isError,
    });
    first ??= repeat ?? undefined;
  }
  return first;
}

async function logStep(
  l: Loop,
  fields: {
    step: number;
    phase: TaskState["phase"];
    response: ChatResponse;
    contextTokens: number;
    costUsd: number;
    durationMs: number;
    calls: ToolCall[];
    done: ExecutedCall[];
  },
): Promise<void> {
  const contextEvents = l.pendingEvents.splice(0);
  if (!l.opts.trajectory) return;
  const { response, calls, done } = fields;
  const entry: TrajectoryStep = {
    step: fields.step,
    phase: fields.phase,
    model: l.opts.provider.id,
    promptVersion: PROMPT_VERSION,
    tokens: {
      input: response.usage.inputTokens,
      output: response.usage.outputTokens,
      cachedInput: response.usage.cachedInputTokens,
    },
    contextTokens: fields.contextTokens,
    response: { text: textOf(response.content), stopReason: response.stopReason },
    toolCalls: calls,
    toolResults: done.map((d) => ({
      id: d.call.id,
      name: d.call.name,
      output: d.shown,
      isError: d.isError,
    })),
    costUsd: fields.costUsd,
    durationMs: fields.durationMs,
    ...(contextEvents.length > 0 ? { contextEvents } : {}),
  };
  await l.opts.trajectory.append(entry);
}

type StepOutcome = { done: false } | { done: true; status: RunStatus; message?: string };

const totalCost = (l: Loop): number => l.cost.costUsd + (l.compactCost?.costUsd ?? 0);

function build(l: Loop): ReturnType<typeof buildRequest> {
  const { opts } = l;
  const built = buildRequest({
    system: opts.systemPrompt,
    issue: opts.issue,
    ...(opts.plan === undefined ? {} : { plan: opts.plan }),
    ...(l.summary === undefined ? {} : { compactedSummary: l.summary }),
    state: l.run.task,
    workingSet: [...l.workingSet].map(([path, content]): WorkingFile => ({ path, content })),
    history: l.history,
    recentSteps: opts.recentSteps,
    firstStep: l.firstStep,
    tools: opts.tools.map((t) => toToolDef(t.definition)),
    maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  });
  if (built.staleChanged) l.meter.reset();
  return built;
}

/** Remove the oldest steps from the history without a summary. Returns how many went. */
function dropOldSteps(l: Loop, keep: number): number {
  const { recent, oldSteps } = splitSteps(l.history, keep);
  l.history = recent;
  l.firstStep += oldSteps;
  l.meter.reset();
  return oldSteps;
}

/**
 * Pick how many recent steps to keep so the context lands at or under the target. The summary's
 * size is not known yet, so this only looks at what stays.
 */
function stepsToKeep(l: Loop, target: number): number {
  const most = l.opts.recentSteps ?? DEFAULT_RECENT_STEPS;
  for (let keep = most; keep > 1; keep -= 1) {
    const { recent } = splitSteps(l.history, keep);
    const trial = buildRequest({
      system: l.opts.systemPrompt,
      issue: l.opts.issue,
      ...(l.opts.plan === undefined ? {} : { plan: l.opts.plan }),
      state: l.run.task,
      workingSet: [...l.workingSet].map(([path, content]): WorkingFile => ({ path, content })),
      history: recent,
      tools: l.opts.tools.map((t) => toToolDef(t.definition)),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    if (estimateRequestTokens(trial.request) <= target) return keep;
  }
  return 1;
}

/** Fold old steps into the rolling summary. A failure is logged and does not stop the run. */
async function compact(l: Loop, step: number, tokensBefore: number, target: number): Promise<void> {
  const { compaction } = l.opts;
  if (!compaction) return;
  const { old, recent, oldSteps } = splitSteps(l.history, stepsToKeep(l, target));
  if (oldSteps === 0) return;
  try {
    const result = await compactSteps({
      provider: compaction.provider,
      prices: compaction.prices,
      old,
      firstStep: l.firstStep,
      previousSummary: l.summary,
      state: l.run.task,
    });
    const costUsd = (l.compactCost ??= new CostTracker(compaction.prices)).add(result.usage);
    l.history = recent;
    l.firstStep += oldSteps;
    l.summary = result.summary;
    l.run.task = result.state;
    l.compactions += 1;
    l.meter.reset();
    l.pendingEvents.push({
      kind: "compact",
      tokensBefore,
      droppedSteps: oldSteps,
      firstStep: l.firstStep,
      summary: result.summary,
      costUsd,
    });
  } catch (err) {
    l.compactAfterStep = step + COMPACT_RETRY_AFTER_STEPS;
    l.pendingEvents.push({
      kind: "compact_failed",
      tokensBefore,
      droppedSteps: 0,
      firstStep: l.firstStep,
      error: err instanceof Error ? err.message : String(err),
      costUsd: 0,
    });
  }
}

/**
 * Spec §7A point 6: compact at 50% of the window (down to 25%). At 85% drop the summary, then all
 * but the last few steps. Returns the request to send.
 */
async function prepare(
  l: Loop,
  step: number,
): Promise<{ built: ReturnType<typeof build>; size: number }> {
  let built = build(l);
  let size = l.meter.size(built.request);
  const t = l.thresholds;
  if (!t) return { built, size };

  if (size >= t.compactAt && step >= l.compactAfterStep) {
    await compact(l, step, size, t.compactTarget);
    built = build(l);
    size = l.meter.size(built.request);
  }
  if (size >= t.hardLimit && l.summary !== undefined) {
    l.pendingEvents.push({
      kind: "drop_summary",
      tokensBefore: size,
      droppedSteps: 0,
      firstStep: l.firstStep,
      costUsd: 0,
    });
    l.summary = undefined;
    l.meter.reset();
    built = build(l);
    size = l.meter.size(built.request);
  }
  if (size >= t.hardLimit) {
    const dropped = dropOldSteps(l, HARD_LIMIT_RECENT_STEPS);
    if (dropped > 0) {
      l.pendingEvents.push({
        kind: "trim_history",
        tokensBefore: size,
        droppedSteps: dropped,
        firstStep: l.firstStep,
        costUsd: 0,
      });
      built = build(l);
      size = l.meter.size(built.request);
    }
  }
  return { built, size };
}

/** One model call plus its tool calls. */
async function runStep(l: Loop, step: number): Promise<StepOutcome> {
  const { opts } = l;
  const { built, size: contextTokens } = await prepare(l, step);
  const phase = l.run.task.phase;
  const started = performance.now();

  const response = await opts.provider.chat(built.request);
  const costUsd = l.cost.add(response.usage);
  l.meter.record(response.usage.inputTokens, built.request.messages.length);
  l.steps = step;
  // Providers reject an assistant turn with no content, so keep the history valid.
  const content: ContentBlock[] =
    response.content.length > 0 ? response.content : [{ type: "text", text: "(no response)" }];
  l.history.push({ role: "assistant", content });

  const log = (calls: ToolCall[], done: ExecutedCall[]): Promise<void> =>
    logStep(l, {
      step,
      phase,
      response,
      contextTokens,
      costUsd,
      durationMs: performance.now() - started,
      calls,
      done,
    });

  if (response.stopReason === "error") {
    await log([], []);
    return { done: true, status: "error", message: "The model reported an error." };
  }

  const calls = toolCallsOf(response.content);
  if (calls.length === 0) {
    await log([], []);
    if (l.nudgedNoTool)
      return { done: true, status: "no_tool_use", message: "The model stopped calling tools." };
    l.nudgedNoTool = true;
    l.history.push({ role: "user", content: [{ type: "text", text: NO_TOOL_NUDGE }] });
    return { done: false };
  }

  l.nudgedNoTool = false;
  const done = await executeAll(l, calls, step);
  await log(calls, done);
  if (l.run.submission ?? l.run.plan) return { done: true, status: "submitted" };
  const nudges = [...notesNudge(l, step), ...budgetWarning(l, step)];
  const repeat = findRepeat(l, done);
  if (repeat) {
    l.loopNudges += 1;
    if (l.loopNudges > MAX_LOOP_NUDGES) {
      return {
        done: true,
        status: "stuck",
        message: `The agent kept repeating itself after ${String(MAX_LOOP_NUDGES)} warnings: ${repeat.description}.`,
      };
    }
    nudges.push(loopNudge(repeat.description));
  }
  l.history.push(resultsMessage(done, nudges));
  return { done: false };
}

const addUsage = (a: Usage, b: Usage | undefined): Usage => ({
  inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
  outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
  cachedInputTokens: a.cachedInputTokens + (b?.cachedInputTokens ?? 0),
});

async function finalDiff(sandbox: Sandbox): Promise<string> {
  try {
    return await sandbox.diff();
  } catch {
    return "";
  }
}

interface Ending {
  status: RunStatus;
  message?: string | undefined;
}

/** Step until something ends the run. Any thrown error becomes status `error`. */
async function drive(l: Loop): Promise<Ending> {
  try {
    for (let step = 1; ; step += 1) {
      const check = l.opts.budget.check({ steps: step - 1, costUsd: totalCost(l) });
      if (!check.ok) return { status: "budget_exceeded", message: check.message };
      const outcome = await runStep(l, step);
      if (outcome.done) return outcome;
    }
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Spec §7: call the model, run its tools, repeat until it submits, runs out of budget, or stops
 * using tools. Parallel tool calls run one after another, and their results go back together.
 */
export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const l: Loop = {
    opts,
    run: newRunState(),
    history: [],
    workingSet: new Map(),
    cost: new CostTracker(opts.prices),
    meter: new ContextMeter(),
    steps: 0,
    nudgedNoTool: false,
    lastNotesNudgeStep: 0,
    budgetWarned: false,
    detector: new LoopDetector(),
    loopNudges: 0,
    thresholds: opts.contextWindow === undefined ? undefined : thresholdsFor(opts.contextWindow),
    summary: undefined,
    firstStep: 1,
    compactions: 0,
    compactCost: undefined,
    compactAfterStep: 0,
    pendingEvents: [],
  };
  const { status, message } = await drive(l);

  return {
    status,
    ...(message === undefined ? {} : { message }),
    steps: l.steps,
    costUsd: totalCost(l),
    usage: addUsage(l.cost.usage, l.compactCost?.usage),
    compactions: l.compactions,
    ...(l.run.submission ? { submission: l.run.submission } : {}),
    ...(l.run.plan ? { plan: l.run.plan } : {}),
    state: l.run.task,
    diff: await finalDiff(opts.sandbox),
  };
}

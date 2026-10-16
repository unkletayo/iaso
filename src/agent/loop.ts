import { ContextMeter } from "../context/budget.js";
import { type WorkingFile, buildRequest } from "../context/layers.js";
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
import type { TrajectoryStep, TrajectoryWriter } from "../telemetry/trajectory.js";
import { resolveRepoPath } from "../tools/paths.js";
import type { OutputStore } from "../tools/read-output.js";
import { type Tool, runTool, toToolDef } from "../tools/schema.js";
import { truncateOutput } from "../tools/truncate.js";
import type { Budget } from "./budget.js";
import { NOTES_NUDGE, NOTES_NUDGE_AFTER_STEPS, NO_TOOL_NUDGE, PROMPT_VERSION } from "./prompts.js";

/** M5 adds `stuck`. */
export type RunStatus = "submitted" | "budget_exceeded" | "no_tool_use" | "error";

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
  /** Keep this many recent steps in full. Leave unset until compaction exists (M5). */
  recentSteps?: number | undefined;
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
}

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
      isError: true,
    };
  }
  const ctx = { sandbox: l.opts.sandbox, step, run: l.run };
  const result = await runTool(tool, call.input, ctx, { truncate: false });
  if (call.name === "edit_file" && !result.isError) await trackEdit(l, call);
  return {
    call,
    shown: await present(l, call, result.output, step, callNo),
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
  };
  await l.opts.trajectory.append(entry);
}

type StepOutcome = { done: false } | { done: true; status: RunStatus; message?: string };

/** One model call plus its tool calls. */
async function runStep(l: Loop, step: number): Promise<StepOutcome> {
  const { opts } = l;
  const built = buildRequest({
    system: opts.systemPrompt,
    issue: opts.issue,
    ...(opts.plan === undefined ? {} : { plan: opts.plan }),
    state: l.run.task,
    workingSet: [...l.workingSet].map(([path, content]): WorkingFile => ({ path, content })),
    history: l.history,
    recentSteps: opts.recentSteps,
    tools: opts.tools.map((t) => toToolDef(t.definition)),
    maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  });
  if (built.staleChanged) l.meter.reset();
  const contextTokens = l.meter.size(built.request);
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
  l.history.push(resultsMessage(done, notesNudge(l, step)));
  return { done: false };
}

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
      const check = l.opts.budget.check({ steps: step - 1, costUsd: l.cost.costUsd });
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
  };
  const { status, message } = await drive(l);

  return {
    status,
    ...(message === undefined ? {} : { message }),
    steps: l.steps,
    costUsd: l.cost.costUsd,
    usage: l.cost.usage,
    ...(l.run.submission ? { submission: l.run.submission } : {}),
    ...(l.run.plan ? { plan: l.run.plan } : {}),
    state: l.run.task,
    diff: await finalDiff(opts.sandbox),
  };
}

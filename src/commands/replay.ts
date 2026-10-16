import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { renderPlan } from "../agent/plan.js";
import { NO_TOOL_NUDGE } from "../agent/prompts.js";
import { buildRequest } from "../context/layers.js";
import {
  type TaskState,
  emptyTaskState,
  mergeTaskState,
  planSchema,
  taskStatePatchSchema,
} from "../context/state.js";
import type { ContentBlock, Message } from "../providers/types.js";
import { type TrajectoryStep, readTrajectory, trajectoryPath } from "../telemetry/trajectory.js";

const PREVIEW_CHARS = 160;

const oneLine = (text: string, max = PREVIEW_CHARS): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
};

/** `iaso replay <runId>`: one block per step. */
export function renderTrajectory(steps: readonly TrajectoryStep[]): string {
  const out: string[] = [];
  for (const s of steps) {
    out.push(
      `step ${String(s.step)} [${s.phase}] ${s.model}  context ~${String(s.contextTokens)} tokens, ` +
        `in ${String(s.tokens.input)} / out ${String(s.tokens.output)}, $${s.costUsd.toFixed(4)}, ${String(Math.round(s.durationMs))} ms`,
    );
    for (const e of s.contextEvents ?? []) {
      out.push(
        `  context: ${e.kind}, was ~${String(e.tokensBefore)} tokens, dropped ${String(e.droppedSteps)} steps, history now starts at step ${String(e.firstStep)}${e.error ? ` (${oneLine(e.error)})` : ""}`,
      );
    }
    if (s.response.text.trim() !== "") out.push(`  said: ${oneLine(s.response.text)}`);
    for (const call of s.toolCalls) {
      out.push(`  call ${call.name} ${oneLine(JSON.stringify(call.input))}`);
      const result = s.toolResults.find((r) => r.id === call.id);
      if (result) out.push(`    ${result.isError ? "error" : "result"}: ${oneLine(result.output)}`);
    }
    if (s.toolCalls.length === 0)
      out.push(`  (no tool call, stop reason ${s.response.stopReason})`);
  }
  return out.join("\n");
}

/** The messages the loop added for one logged step. */
function messagesOf(s: TrajectoryStep): Message[] {
  const blocks: ContentBlock[] = [
    ...(s.response.text === "" ? [] : [{ type: "text" as const, text: s.response.text }]),
    ...s.toolCalls.map((c) => ({
      type: "tool_call" as const,
      id: c.id,
      name: c.name,
      input: c.input,
    })),
  ];
  const assistant: Message = {
    role: "assistant",
    content: blocks.length > 0 ? blocks : [{ type: "text", text: "(no response)" }],
  };
  if (s.toolCalls.length === 0) {
    return [assistant, { role: "user", content: [{ type: "text", text: NO_TOOL_NUDGE }] }];
  }
  const results: Message = {
    role: "user",
    content: s.toolResults.map((r) => ({
      type: "tool_result" as const,
      id: r.id,
      output: r.output,
      isError: r.isError,
    })),
  };
  return [assistant, results];
}

export interface ReplayContext {
  /** Every message the model got at the step, in order. */
  messages: Message[];
  /** Context steps that were summarised away before it. */
  summary: string | undefined;
  firstStep: number;
}

export interface ReplayInput {
  steps: readonly TrajectoryStep[];
  step: number;
  issue: string | undefined;
  plan: string | undefined;
}

/**
 * Rebuild the request of step `step` from the log, through the same `buildRequest` the loop uses.
 * Not byte-exact: tool results are the logged (trimmed) text, notes are rebuilt from `notes` calls,
 * and the working set and the notes/loop nudges are not logged.
 */
export function replayContext(input: ReplayInput): ReplayContext {
  let summary: string | undefined;
  let firstStep = 1;
  let state: TaskState = emptyTaskState();
  const logged: { step: number; messages: Message[] }[] = [];
  for (const s of input.steps) {
    for (const e of s.contextEvents ?? []) {
      if (e.kind === "compact") summary = e.summary;
      else if (e.kind === "drop_summary") summary = undefined;
      if (e.kind !== "compact_failed") firstStep = e.firstStep;
    }
    if (s.step >= input.step) break;
    logged.push({ step: s.step, messages: messagesOf(s) });
    for (const call of s.toolCalls.filter((c) => c.name === "notes")) {
      const failed = s.toolResults.find((r) => r.id === call.id)?.isError ?? true;
      const patch = taskStatePatchSchema.safeParse(call.input);
      if (!failed && patch.success) state = mergeTaskState(state, patch.data, s.step);
    }
  }
  const kept = logged.filter((l) => l.step >= firstStep).flatMap((l) => l.messages);
  const built = buildRequest({
    system: "",
    issue: input.issue ?? "(issue.md was not saved for this run)",
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    ...(summary === undefined ? {} : { compactedSummary: summary }),
    state,
    workingSet: [],
    history: kept,
    firstStep,
    tools: [],
    maxOutputTokens: 0,
  });
  return { messages: built.request.messages, summary, firstStep };
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_call":
      return `[call ${block.id}] ${block.name} ${JSON.stringify(block.input)}`;
    case "tool_result":
      return `[result ${block.id}${block.isError ? ", error" : ""}]\n${block.output}`;
  }
}

export function renderMessages(messages: readonly Message[]): string {
  return messages
    .map(
      (m, i) =>
        `===== message ${String(i + 1)} (${m.role}) =====\n${m.content.map(renderBlock).join("\n\n")}`,
    )
    .join("\n\n");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function savedPlan(runDir: string): Promise<string | undefined> {
  const text = await readOptional(join(runDir, "plan.json"));
  if (text === undefined) return undefined;
  try {
    const parsed = planSchema.safeParse(JSON.parse(text));
    return parsed.success ? renderPlan(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}

export interface ReplayOptions {
  runs: string;
  context?: number;
}

export async function executeReplay(
  runId: string,
  opts: ReplayOptions,
  log: (text: string) => void,
): Promise<void> {
  const runDir = join(resolve(opts.runs), runId);
  const steps = await readTrajectory(trajectoryPath(resolve(opts.runs), runId));
  if (opts.context === undefined) {
    log(renderTrajectory(steps));
    return;
  }
  const last = steps.at(-1)?.step ?? 0;
  if (opts.context < 1 || opts.context > last) {
    throw new Error(`--context must be a step from 1 to ${String(last)}.`);
  }
  const replay = replayContext({
    steps,
    step: opts.context,
    issue: await readOptional(join(runDir, "issue.md")),
    plan: await savedPlan(runDir),
  });
  log(
    `context the model saw at step ${String(opts.context)} (rebuilt from the log; tool results are as logged, the working set and nudges are not shown):\n\n${renderMessages(replay.messages)}`,
  );
}

function stepNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error("--context must be a whole number, 1 or more.");
  return n;
}

export function registerReplay(
  program: Command,
  log: (text: string) => void = (t) => {
    console.log(t);
  },
): void {
  program
    .command("replay")
    .description("Print a run's trajectory, or the context the model saw at one step")
    .argument("<runId>", "run folder name under --runs")
    .option("--runs <dir>", "where run folders are", "runs")
    .option("--context <step>", "print what the model saw at this step", stepNumber)
    .action(async (runId: string, opts: ReplayOptions) => {
      await executeReplay(runId, opts, log);
    });
}

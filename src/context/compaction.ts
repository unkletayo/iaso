import { z } from "zod";
import type {
  ChatRequest,
  ContentBlock,
  Message,
  ModelProvider,
  Usage,
} from "../providers/types.js";
import { type ModelPrices, computeCost } from "../telemetry/cost.js";
import { defineTool, toToolDef } from "../tools/schema.js";
import { type TaskState, mergeTaskState } from "./state.js";

/** Bump on any change to the compaction prompt. */
export const COMPACT_PROMPT_VERSION = "1.0.0";

/** Each tool result is cut to this many characters before the compactor sees it. */
export const COMPACTOR_RESULT_CHARS = 1500;
/** The compactor never sees more than this many characters of old steps (about 85k tokens). */
export const COMPACTOR_INPUT_CHARS = 300_000;
const COMPACTOR_MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;

export const COMPACT_PROMPT = `You are compacting the work log of a coding agent that is fixing a bug.

You get the steps the agent took (tool calls and results) and, if there is one, the summary of even earlier steps. Call record_summary with a complete, updated summary that replaces both. The agent will not see the old steps again, so keep every fact it still needs:
- learned: what was found out (facts only, each one short and specific).
- files: files and line ranges that matter, and why.
- tests: tests that were run and their results.
- failedApproaches: ideas that were tried and failed, and why. Never drop one.

Keep what is still true. Drop what was later proven wrong or is no longer needed. Do not repeat what is already in the agent's notes. Do not add advice or plans.`;

/** What the compactor returns: the fixed structure of spec §7A point 6. */
export const stepSummarySchema = z.strictObject({
  learned: z.array(z.string().min(1)),
  files: z.array(z.strictObject({ path: z.string().min(1), why: z.string() })),
  tests: z.array(z.string().min(1)),
  failedApproaches: z.array(z.strictObject({ what: z.string().min(1), whyItFailed: z.string() })),
});

export type StepSummary = z.infer<typeof stepSummarySchema>;

const recordSummary = defineTool({
  name: "record_summary",
  description: "Record the updated summary of the agent's earlier steps.",
  input: stepSummarySchema,
});

export class CompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionError";
  }
}

/**
 * Split history at a step boundary. A step starts at an assistant message and includes the results
 * that follow it, so `recent` always starts with an assistant message and pairs stay whole.
 */
export function splitSteps(
  history: readonly Message[],
  keepRecent: number,
): { old: Message[]; recent: Message[]; oldSteps: number } {
  const keep = Math.max(keepRecent, 0);
  const starts = history.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  if (keep >= starts.length) return { old: [], recent: [...history], oldSteps: 0 };
  const cut = keep === 0 ? history.length : (starts[starts.length - keep] ?? history.length);
  return { old: history.slice(0, cut), recent: history.slice(cut), oldSteps: starts.length - keep };
}

const cutText = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n[cut: ${String(text.length - max)} more characters]`;

function renderBlock(block: ContentBlock): string[] {
  switch (block.type) {
    case "text":
      return [`said: ${cutText(block.text, COMPACTOR_RESULT_CHARS)}`];
    case "tool_call":
      return [`call ${block.name} ${cutText(JSON.stringify(block.input), COMPACTOR_RESULT_CHARS)}`];
    case "tool_result":
      return [
        `result${block.isError ? " (error)" : ""}: ${cutText(block.output, COMPACTOR_RESULT_CHARS)}`,
      ];
  }
}

/** The old steps as plain text for the compactor. User text (nudges) is left out. */
export function renderStepsForCompactor(old: readonly Message[], firstStep: number): string {
  const parts: string[] = [];
  let step = firstStep - 1;
  for (const message of old) {
    if (message.role === "assistant") {
      step += 1;
      parts.push(`### step ${String(step)}`);
    }
    const blocks =
      message.role === "user"
        ? message.content.filter((b) => b.type === "tool_result")
        : message.content;
    for (const block of blocks) parts.push(...renderBlock(block));
  }
  const text = parts.join("\n");
  return text.length <= COMPACTOR_INPUT_CHARS
    ? text
    : `[earlier steps cut; the previous summary covers them]\n${text.slice(text.length - COMPACTOR_INPUT_CHARS)}`;
}

const list = (items: string[]): string =>
  items.length === 0 ? "(none)" : items.map((i) => `- ${i}`).join("\n");

/** Fixed structure, fixed order: the same summary always renders the same bytes. */
export function renderSummary(s: StepSummary): string {
  return [
    `learned:\n${list(s.learned)}`,
    `files and lines that matter:\n${list(s.files.map((f) => `${f.path}: ${f.why}`))}`,
    `tests run:\n${list(s.tests)}`,
    `failed approaches:\n${list(s.failedApproaches.map((f) => `${f.what} (failed because: ${f.whyItFailed})`))}`,
  ].join("\n");
}

/** Spec §7A point 6: merge the summary's facts into the task state. Facts get the last compacted step. */
export function mergeSummaryIntoState(
  state: TaskState,
  summary: StepSummary,
  lastCompactedStep: number,
): TaskState {
  return mergeTaskState(
    state,
    {
      confirmedFacts: summary.learned,
      filesExamined: summary.files,
      failedApproaches: summary.failedApproaches,
    },
    lastCompactedStep,
  );
}

export interface CompactInput {
  provider: ModelProvider;
  prices: ModelPrices;
  /** The steps to fold into the summary (the `old` part of `splitSteps`). */
  old: readonly Message[];
  /** Absolute step number of the first message in `old`. */
  firstStep: number;
  /** The summary of even earlier steps, as last rendered. */
  previousSummary?: string | undefined;
  state: TaskState;
}

export interface CompactResult {
  /** The new rendered summary. It replaces `previousSummary`. */
  summary: string;
  structured: StepSummary;
  /** The state with the summary's facts merged in. */
  state: TaskState;
  usage: Usage;
  costUsd: number;
}

function requestFor(input: CompactInput): ChatRequest {
  const sections = [
    input.previousSummary === undefined
      ? "## Summary of earlier steps\n\n(none yet)"
      : `## Summary of earlier steps\n\n${input.previousSummary}`,
    `## Steps to fold in\n\n${renderStepsForCompactor(input.old, input.firstStep)}`,
  ];
  return {
    system: COMPACT_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: sections.join("\n\n") }] }],
    tools: [toToolDef(recordSummary)],
    maxOutputTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
  };
}

/** Why an attempt gave no usable summary, as a user message the model can act on. */
function retryMessage(content: ContentBlock[], problem: string): Message {
  const results: ContentBlock[] = content.flatMap((b) =>
    b.type === "tool_call"
      ? [{ type: "tool_result" as const, id: b.id, output: problem, isError: true }]
      : [],
  );
  return {
    role: "user",
    content: [...results, { type: "text", text: "Call record_summary with the updated summary." }],
  };
}

/** Ask the compactor model for a new summary. Retries once; throws `CompactionError` on failure. */
export async function compactSteps(input: CompactInput): Promise<CompactResult> {
  const request = requestFor(input);
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let costUsd = 0;
  let problem = "no tool call";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await input.provider.chat(request);
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cachedInputTokens += response.usage.cachedInputTokens;
    costUsd += computeCost(response.usage, input.prices);

    const call = response.content.find(
      (b) => b.type === "tool_call" && b.name === "record_summary",
    );
    if (call?.type === "tool_call") {
      const parsed = stepSummarySchema.safeParse(call.input);
      if (parsed.success) {
        const lastStep =
          input.firstStep + input.old.filter((m) => m.role === "assistant").length - 1;
        return {
          summary: renderSummary(parsed.data),
          structured: parsed.data,
          state: mergeSummaryIntoState(input.state, parsed.data, lastStep),
          usage,
          costUsd,
        };
      }
      problem = z.prettifyError(parsed.error);
    } else {
      problem = "The compactor answered without calling record_summary.";
    }
    request.messages = [
      ...request.messages,
      {
        role: "assistant",
        content:
          response.content.length > 0
            ? response.content
            : [{ type: "text", text: "(no response)" }],
      },
      retryMessage(response.content, problem),
    ];
  }
  throw new CompactionError(`Compaction failed after ${String(MAX_ATTEMPTS)} attempts: ${problem}`);
}

import type { ChatRequest, ContentBlock, Message, ToolDef } from "../providers/types.js";
import { MAX_READ_LINES } from "../tools/read-file.js";
import { splitSteps } from "./compaction.js";
import { applyStaleness } from "./staleness.js";
import type { TaskState } from "./state.js";

/** Spec §7A point 2: the working set shows at most this many lines per file. */
export const WORKING_SET_MAX_LINES = 200;
/** Spec §7A point 2: last N steps in full. */
export const DEFAULT_RECENT_STEPS = 8;

export interface WorkingFile {
  path: string;
  /** The latest content of a file the agent edited. */
  content: string;
}

export interface LayerInput {
  /** Pinned: stable system prompt. */
  system: string;
  /** Pinned: the issue text. */
  issue: string;
  /** Pinned: the approved plan, once plan mode exists (M6). */
  plan?: string;
  state: TaskState;
  workingSet: readonly WorkingFile[];
  /** Compacted history summary (M5). */
  compactedSummary?: string;
  /** Every message since the issue: assistant tool calls and user tool results, in order. */
  history: readonly Message[];
  /** Keep this many recent steps in full. Omit to keep all. */
  recentSteps?: number | undefined;
  /** Absolute step number of the first message in `history` (later than 1 after compaction). */
  firstStep?: number | undefined;
  tools: ToolDef[];
  maxOutputTokens: number;
}

export interface BuiltRequest {
  request: ChatRequest;
  /** Steps left out because they are older than `recentSteps`. */
  omittedSteps: number;
  /** True when staleness marking rewrote a file read. */
  staleChanged: boolean;
}

const list = (items: string[]): string =>
  items.length === 0 ? "(none)" : items.map((i) => `- ${i}`).join("\n");

/** Plain text, fixed order, so the same state always renders the same bytes. */
export function renderTaskState(s: TaskState): string {
  return [
    "## Your notes (task state)",
    `phase: ${s.phase}`,
    `root cause hypothesis: ${s.rootCauseHypothesis === "" ? "(none yet)" : s.rootCauseHypothesis}`,
    `confirmed facts:\n${list(s.confirmedFacts)}`,
    `files examined:\n${list(s.filesExamined.map((f) => `${f.path}: ${f.why}`))}`,
    `failed approaches:\n${list(s.failedApproaches.map((f) => `${f.what} (failed because: ${f.whyItFailed})`))}`,
    `tests run:\n${list(s.testsRun.map((t) => `[${t.result}] ${t.cmd} (step ${String(t.step)})`))}`,
    `todo:\n${list(s.todo)}`,
  ].join("\n");
}

function renderFile(file: WorkingFile): string {
  const lines = file.content.split("\n");
  if (file.content.endsWith("\n")) lines.pop();
  const shown = lines.slice(0, WORKING_SET_MAX_LINES);
  const width = String(shown.length).length;
  const body = shown.map((l, i) => `${String(i + 1).padStart(width)}\t${l}`).join("\n");
  const more = lines.length - shown.length;
  const footer =
    more > 0
      ? `\n[${String(more)} more lines. Use read_file with startLine=${String(WORKING_SET_MAX_LINES + 1)}; reads return at most ${String(MAX_READ_LINES)} lines.]`
      : "";
  return `### ${file.path} (latest version, ${String(lines.length)} lines)\n${body}${footer}`;
}

export function renderWorkingSet(files: readonly WorkingFile[]): string {
  if (files.length === 0) return "";
  return `## Files you edited (latest versions)\n\n${files.map(renderFile).join("\n\n")}`;
}

/**
 * Spec §7A point 2: rebuild the request from layers, stable first:
 * pinned (system, issue, plan), compacted summary, task state, working set, recent history.
 * The first user message carries all but the history, as separate text blocks. The order differs
 * from the spec's list on purpose: stable layers first, so two cache breakpoints (after the pinned
 * block and after the summary) keep the prefix identical between steps. History follows as real
 * messages.
 */
export function buildRequest(input: LayerInput): BuiltRequest {
  const stale = applyStaleness(input.history, input.firstStep);
  const { kept, omitted } =
    input.recentSteps === undefined
      ? { kept: stale.messages, omitted: 0 }
      : (({ recent, oldSteps }) => ({ kept: recent, omitted: oldSteps }))(
          splitSteps(stale.messages, input.recentSteps),
        );

  // Pinned: identical on every request of a run.
  const pinned = [`## Issue\n\n${input.issue}`];
  if (input.plan !== undefined) pinned.push(`## Approved plan\n\n${input.plan}`);

  // Volatile: changes on most steps, so it goes last and carries no cache breakpoint.
  const volatile = [renderTaskState(input.state)];
  const workingSet = renderWorkingSet(input.workingSet);
  if (workingSet !== "") volatile.push(workingSet);
  if (input.compactedSummary === undefined && omitted > 0) {
    volatile.push(
      `[${String(omitted)} earlier steps are not shown. Your notes above keep what mattered.]`,
    );
  }

  const content: ContentBlock[] = [
    { type: "text", text: pinned.join("\n\n"), cacheBreakpoint: true },
  ];
  // The summary only changes at compaction, so it sits before the volatile layers.
  if (input.compactedSummary !== undefined) {
    content.push({
      type: "text",
      text: `## Summary of earlier steps\n\n${input.compactedSummary}`,
      cacheBreakpoint: true,
    });
  }
  content.push({ type: "text", text: volatile.join("\n\n") });

  return {
    request: {
      system: input.system,
      messages: [{ role: "user", content }, ...kept],
      tools: input.tools,
      maxOutputTokens: input.maxOutputTokens,
    },
    omittedSteps: omitted,
    staleChanged: stale.changed,
  };
}

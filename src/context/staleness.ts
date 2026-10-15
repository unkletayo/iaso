import type { ContentBlock, Message } from "../providers/types.js";
import { editFileDefinition } from "../tools/edit-file.js";
import { PathError, resolveRepoPath } from "../tools/paths.js";
import { readFileDefinition } from "../tools/read-file.js";

/** A tool call seen in history, with the loop step it was made in. */
interface SeenCall {
  step: number;
  name: string;
  input: unknown;
}

interface Read {
  step: number;
  id: string;
  path: string;
  /** Same path and same line range means the same request. */
  key: string;
  output: string;
}

/** Spec §7A point 5. Stale content is replaced by a marker, so the file is not paid for twice. */
export interface StalenessResult {
  messages: Message[];
  /** True when anything was replaced; the caller must reset its token meter. */
  changed: boolean;
}

export const outdatedMarker = (step: number): string =>
  `[outdated: file changed at step ${String(step)}]`;
export const sameContentMarker = (step: number): string => `[same content as step ${String(step)}]`;

function toRepoPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return resolveRepoPath(raw);
  } catch (err) {
    if (err instanceof PathError) return undefined;
    throw err;
  }
}

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
}

/** Index every tool call by id. Step n is the n-th assistant message, counting from `firstStep`. */
function indexCalls(messages: readonly Message[], firstStep: number): Map<string, SeenCall> {
  const calls = new Map<string, SeenCall>();
  let step = firstStep - 1;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    step += 1;
    for (const block of message.content) {
      if (block.type === "tool_call")
        calls.set(block.id, { step, name: block.name, input: block.input });
    }
  }
  return calls;
}

function collect(messages: readonly Message[], calls: Map<string, SeenCall>) {
  const reads: Read[] = [];
  const edits: { step: number; path: string }[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.isError) continue;
      const call = calls.get(block.id);
      const path = call && toRepoPath(field(call.input, "path"));
      if (!call || path === undefined) continue;
      if (call.name === readFileDefinition.name) {
        const key = `${path}:${String(field(call.input, "startLine"))}-${String(field(call.input, "endLine"))}`;
        reads.push({ step: call.step, id: block.id, path, key, output: block.output });
      } else if (call.name === editFileDefinition.name) {
        edits.push({ step: call.step, path });
      }
    }
  }
  return { reads, edits };
}

/** Decide the replacement text per read result id. An edit beats a repeat. */
function plan(reads: Read[], edits: { step: number; path: string }[]): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const [i, read] of reads.entries()) {
    const edit = edits.find((e) => e.path === read.path && e.step > read.step);
    if (edit) {
      replacements.set(read.id, outdatedMarker(edit.step));
      continue;
    }
    // Later identical read, with the same content: keep only the newest copy.
    const repeat = reads.slice(i + 1).find((r) => r.key === read.key && r.output === read.output);
    if (repeat) replacements.set(read.id, sameContentMarker(repeat.step));
  }
  return replacements;
}

/**
 * Mark outdated and repeated file reads. Pure: returns new messages and leaves the input alone.
 * Only `edit_file` is tracked; a file changed through `bash` (sed -i, a formatter) is not seen.
 * `firstStep` is the step number of the first assistant message, for histories that start later.
 */
export function applyStaleness(messages: readonly Message[], firstStep = 1): StalenessResult {
  const calls = indexCalls(messages, firstStep);
  const { reads, edits } = collect(messages, calls);
  const replacements = plan(reads, edits);
  let changed = false;
  const rewrite = (block: ContentBlock): ContentBlock => {
    const marker = block.type === "tool_result" ? replacements.get(block.id) : undefined;
    if (block.type !== "tool_result" || marker === undefined || block.output === marker)
      return block;
    changed = true;
    return { ...block, output: marker };
  };
  const result = messages.map((m) => ({ ...m, content: m.content.map(rewrite) }));
  return { messages: result, changed };
}

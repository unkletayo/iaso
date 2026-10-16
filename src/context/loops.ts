import { classifyCommand } from "./shaping.js";

/** Spec §7A point 7: the third identical action is a repeat. */
export const REPEAT_THRESHOLD = 3;

export type RepeatKind = "command" | "edit" | "test_failure";

export interface Repeat {
  kind: RepeatKind;
  /** How many times it has happened so far. */
  count: number;
  /** Short text for the nudge and the run message. */
  description: string;
}

/** What the detector needs to know about one finished tool call. */
export interface ObservedCall {
  name: string;
  input: unknown;
  /** The raw tool output, before shaping, so a "read_output" pointer cannot change it. */
  output: string;
  isError: boolean;
}

function field(input: unknown, name: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

const squash = (text: string): string => text.trim().replace(/\s+/g, " ");

const short = (text: string, max = 80): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`;

/** Drop what changes between identical runs: durations and timestamps. */
export function failureFingerprint(output: string): string {
  return output
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "<time>")
    .replace(/\b(duration_ms|time|elapsed)\s*[:=]?\s*\d+(\.\d+)?/gi, "$1 <n>")
    .replace(/\(?\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b\)?/g, "<n>ms")
    .trim()
    .slice(0, 4000);
}

function exitCodeOf(output: string): number | undefined {
  const match = /^exit code: (-?\d+)/.exec(output);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Counts repeated actions across a run. It only counts; the loop decides what to do about it.
 *
 * - A command repeats when the same command text runs again. A successful `edit_file` in between
 *   resets these counts: running the tests after each edit is the normal workflow, not a loop.
 * - An edit repeats when the same path, oldText and newText are sent again (even if it failed).
 * - A test failure repeats when a failing test command prints the same failure again, whatever
 *   command line was used and whatever edits came between.
 */
export class LoopDetector {
  private readonly commands = new Map<string, number>();
  private readonly edits = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly threshold: number = REPEAT_THRESHOLD) {}

  private bump(map: Map<string, number>, key: string): number {
    const count = (map.get(key) ?? 0) + 1;
    map.set(key, count);
    return count;
  }

  /** Record one call. Returns the repeat it caused, if any (edit, then test failure, then command). */
  observe(call: ObservedCall): Repeat | null {
    if (call.name === "edit_file") return this.observeEdit(call);
    if (call.name === "bash") return this.observeCommand(call);
    return null;
  }

  private observeEdit(call: ObservedCall): Repeat | null {
    const path = field(call.input, "path") ?? "";
    const key = JSON.stringify([path, field(call.input, "oldText"), field(call.input, "newText")]);
    const count = this.bump(this.edits, key);
    if (!call.isError) this.commands.clear();
    return count >= this.threshold
      ? { kind: "edit", count, description: `the same edit to ${path} ${String(count)} times` }
      : null;
  }

  private observeCommand(call: ObservedCall): Repeat | null {
    const cmd = squash(field(call.input, "cmd") ?? "");
    if (cmd === "") return null;
    const commandCount = this.bump(this.commands, cmd);

    let failure: Repeat | null = null;
    const exit = exitCodeOf(call.output);
    if (classifyCommand(cmd) === "test" && exit !== undefined && exit !== 0) {
      const count = this.bump(this.failures, failureFingerprint(call.output));
      if (count >= this.threshold) {
        failure = {
          kind: "test_failure",
          count,
          description: `the same test failure ${String(count)} times (latest: ${short(cmd)})`,
        };
      }
    }
    if (failure) return failure;
    return commandCount >= this.threshold
      ? {
          kind: "command",
          count: commandCount,
          description: `the command "${short(cmd)}" ${String(commandCount)} times`,
        }
      : null;
  }
}

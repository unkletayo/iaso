import { z } from "zod";
import { bashTool } from "./bash.js";
import { type Tool, defineTool } from "./schema.js";

/** Programs the plan phase may run. All of them only read. */
const ALLOWED = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "git",
  "file",
  "stat",
  "pwd",
]);
const GIT_ALLOWED = new Set(["log", "diff", "show", "status", "ls-files", "grep", "blame"]);
/** Options that make an otherwise read-only program run commands or write files. */
const FORBIDDEN_ARGS: Record<string, readonly RegExp[]> = {
  find: [/^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/],
  rg: [/^--pre(=|$)/],
  git: [/^--output(=|$)/, /^--ext-diff$/],
};

/**
 * Replace everything inside quotes with `_`, so operators in a search pattern do not count.
 * Returns null when quoting is unbalanced, or a double-quoted string has $, a backtick or a
 * backslash (it could run a command or hide a quote).
 */
function skeleton(cmd: string): string | null {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (const ch of cmd) {
    if (quote === null) {
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += "_";
      } else out += ch;
    } else if (ch === quote) quote = null;
    else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return null;
    else out += "_";
  }
  return quote === null ? out : null;
}

/** Why the command is not allowed in the plan phase, or null when it is. */
export function readOnlyViolation(cmd: string): string | null {
  const flat = skeleton(cmd);
  if (flat === null) return "Unbalanced quotes, or $, backtick or backslash inside double quotes.";
  if (/[;&<>`$\\\n(){}]/.test(flat))
    return "Only plain commands joined by | are allowed (no ;, &, redirects, $, backticks or subshells).";
  for (const segment of flat.split("|")) {
    const words = segment.trim().split(/\s+/);
    const program = words[0] ?? "";
    if (!ALLOWED.has(program))
      return `"${program}" is not allowed in the plan phase. Allowed: ${[...ALLOWED].join(", ")}.`;
    if (program === "git" && !GIT_ALLOWED.has(words[1] ?? ""))
      return `git ${words[1] ?? ""} is not allowed. Allowed: ${[...GIT_ALLOWED].join(", ")}.`;
    const bad = words.slice(1).find((w) => FORBIDDEN_ARGS[program]?.some((re) => re.test(w)));
    if (bad !== undefined) return `The option ${bad} is not allowed in the plan phase.`;
  }
  return null;
}

export const readOnlyBashDefinition = defineTool({
  name: "bash",
  description:
    "Run a read-only shell command in /repo (plan phase). Allowed programs: " +
    `${[...ALLOWED].join(", ")} (git: ${[...GIT_ALLOWED].join(", ")}). Join commands with | only. ` +
    "No redirects, no ; or &&, no $ or backticks. Returns the exit code, stdout and stderr.",
  input: z.strictObject({
    cmd: z.string().min(1),
    timeoutSec: z.number().int().min(1).max(600).optional(),
  }),
});

export const readOnlyBashTool: Tool<typeof readOnlyBashDefinition.input> = {
  definition: readOnlyBashDefinition,
  run(input, ctx) {
    const why = readOnlyViolation(input.cmd);
    if (why !== null) {
      return Promise.resolve({ output: `Command refused: ${why}`, isError: true });
    }
    return bashTool.run(input, ctx);
  },
};

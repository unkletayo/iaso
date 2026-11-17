import { z } from "zod";

/**
 * M13 step 13H: look for secrets in the patch before it is written out. Only the lines the patch
 * adds are read. A finding names the kind, the file and the diff line, never the matched text, so
 * the report and the pull request draft can mention it without repeating it. The patch is still
 * written; `iaso pr --push` is blocked until a person has dealt with the finding.
 */

export const secretFindingSchema = z.object({
  kind: z.string(),
  /** The file the added line belongs to, from the diff header; absent for a malformed diff. */
  file: z.string().optional(),
  /** 1-based line number in the diff text. */
  line: z.number().int().min(1),
});
export type SecretFinding = z.infer<typeof secretFindingSchema>;

const PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "private key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
];

/** `api_key = "…"` and the like, with a value long enough to be real. */
const ASSIGNMENT =
  /\b(?:api[_-]?key|secret[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token|token)\b\s*[:=]\s*["'`]([^"'`]{12,})["'`]/i;
/** Values that are plainly stand-ins, not secrets. */
const PLACEHOLDER = /example|placeholder|dummy|your[-_ ]|xxx|changeme|<[^>]*>|\$\{|\.\.\./i;

/** The lines a unified diff adds: `+` lines that are not the `+++` file header. */
function addedLine(line: string): string | undefined {
  if (!line.startsWith("+") || line.startsWith("+++")) return undefined;
  return line.slice(1);
}

function kindOf(text: string): string | undefined {
  for (const { kind, re } of PATTERNS) if (re.test(text)) return kind;
  const assigned = ASSIGNMENT.exec(text)?.[1];
  if (assigned !== undefined && !PLACEHOLDER.test(assigned)) return "a credential-looking value";
  return undefined;
}

/** Scan a unified diff. Findings are in diff order. */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file: string | undefined;
  for (const [i, line] of diff.split("\n").entries()) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const text = addedLine(line);
    if (text === undefined) continue;
    const kind = kindOf(text);
    if (kind === undefined) continue;
    findings.push({ kind, ...(file === undefined ? {} : { file }), line: i + 1 });
  }
  return findings;
}

/** One line per finding, for `report.md`, the console and the pull request reminders. */
export function describeFinding(f: SecretFinding): string {
  return `${f.kind} in ${f.file ?? "(unknown file)"}, diff line ${String(f.line)}`;
}

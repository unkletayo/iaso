/** Spec §7A point 4: trim tool output before it enters history. Pure functions over strings. */

export type OutputKind = "test" | "build" | "search" | "other";

export interface Shaped {
  text: string;
  /** True when lines were dropped or regrouped, so the caller can point to the raw output. */
  shaped: boolean;
}

const TEST_CMD =
  /\b(test|tests|jest|vitest|pytest|mocha|rspec|phpunit|unittest|go test|cargo test|mvn|gradle)\b/;
const SEARCH_CMD = /\b(grep|rg|ag|ack)\b/;
const BUILD_CMD = /\b(tsc|eslint|make|gcc|g\+\+|clang|javac|cargo (build|check)|go build)\b/;

/** Guess from the command line. Tests win over search, so `npm test | grep x` is shaped as tests. */
export function classifyCommand(cmd: string): OutputKind {
  if (TEST_CMD.test(cmd)) return "test";
  if (SEARCH_CMD.test(cmd)) return "search";
  if (BUILD_CMD.test(cmd)) return "build";
  return "other";
}

export function shapeOutput(kind: OutputKind, raw: string): Shaped {
  switch (kind) {
    case "test":
      return shapeTestOutput(raw);
    case "build":
      return shapeCompilerOutput(raw);
    case "search":
      return shapeSearchOutput(raw);
    case "other":
      return { text: raw, shaped: false };
  }
}

// --- test output -------------------------------------------------------------------------------

const PASSED_LINE = [
  /^\s*[✓✔√]\s/,
  /^\s*ok \d+ - /, // TAP
  /^\s*PASS\s/, // jest file header
  /\sPASSED\b/, // pytest -v
  /^\s*--- PASS/, // go test
  /^\s*=== (RUN|PAUSE|CONT)\b/, // go test chatter
];

/** A stack frame in code we do not own: dependencies and runtime internals. */
const FRAMEWORK_FRAME = [
  /^\s+at .*(node_modules|node:internal|\(node:)/,
  /^\s+at (org\.junit|java\.base|jdk\.internal|sun\.reflect|org\.apache\.maven|org\.gradle)\b/,
  /^\s*File ".*(site-packages|\/usr\/lib\/python|<frozen)/,
];

const isPassed = (line: string): boolean => PASSED_LINE.some((re) => re.test(line));
const isFrameworkFrame = (line: string): boolean => FRAMEWORK_FRAME.some((re) => re.test(line));
const isPythonFrame = (line: string): boolean => /^\s*File "/.test(line);

/**
 * Drop passed-test lines and framework stack frames; keep everything else (summary line, failed
 * names, assertion messages, frames in the repo). Unknown lines stay: losing a real failure is
 * worse than a few extra lines.
 */
export function shapeTestOutput(raw: string): Shaped {
  const kept: string[] = [];
  let dropped = 0;
  let skipSourceLine = false;
  for (const line of raw.split("\n")) {
    if (skipSourceLine) {
      skipSourceLine = false;
      // Python prints the source line under each frame; it belongs to the dropped frame.
      if (/^\s{4}\S/.test(line)) {
        dropped += 1;
        continue;
      }
    }
    if (isPassed(line) || isFrameworkFrame(line)) {
      dropped += 1;
      skipSourceLine = isPythonFrame(line);
      continue;
    }
    kept.push(line);
  }
  if (dropped === 0) return { text: raw, shaped: false };
  const note = `[${String(dropped)} passed-test and framework lines omitted]`;
  return { text: `${kept.join("\n").replace(/\n+$/, "")}\n${note}`, shaped: true };
}

// --- compiler and type errors --------------------------------------------------------------------

/** tsc, gcc, clang, go, javac: `file(l,c): error ...` or `file:l:c: error ...`; rustc: `error[E0]:` */
const ERROR_START =
  /^(?:[^\s:(][^:(]*[(:]\d+[,:]\d+\)?:?\s*[-:]?\s*(?:fatal )?error\b|(?:fatal )?error(?:\[\w+\])?:)/i;
const CONTINUATION = /^(\s|\||-->|\d+\s*\|)/;
const SUMMARY = /\b(found )?\d+ errors?\b/i;
const MAX_SHORT_ERRORS = 5;

interface ErrorBlock {
  head: string;
  rest: string[];
}

function parseErrorBlocks(lines: string[]): { blocks: ErrorBlock[]; summary: string[] } {
  const blocks: ErrorBlock[] = [];
  const summary: string[] = [];
  let current: ErrorBlock | undefined;
  for (const line of lines) {
    if (ERROR_START.test(line)) {
      current = { head: line, rest: [] };
      blocks.push(current);
    } else if (current && CONTINUATION.test(line)) {
      current.rest.push(line);
    } else {
      current = undefined;
      if (SUMMARY.test(line)) summary.push(line);
    }
  }
  return { blocks, summary };
}

/** First error in full, errors 2 to 5 as one line each, a count of the rest, then the summary. */
export function shapeCompilerOutput(raw: string): Shaped {
  const { blocks, summary } = parseErrorBlocks(raw.split("\n"));
  if (blocks.length < 2) return { text: raw, shaped: false };

  const [first, ...others] = blocks;
  const out: string[] = [first?.head ?? "", ...(first?.rest ?? [])];
  const shown = others.slice(0, MAX_SHORT_ERRORS - 1);
  out.push(...shown.map((b) => b.head));
  const hidden = others.length - shown.length;
  if (hidden > 0) out.push(`[... and ${String(hidden)} more errors]`);
  out.push(...summary);
  return { text: out.join("\n"), shaped: true };
}

// --- search output -------------------------------------------------------------------------------

export const MAX_SEARCH_MATCHES = 50;
const MATCH_LINE = /^(\.\/)?([^\s:][^:]*):(\d+):(?:\d+:)?(.*)$/;

/** Group `path:line:text` matches by file and cap at 50. Anything else is returned unchanged. */
export function shapeSearchOutput(raw: string): Shaped {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const parsed = lines.map((l) => MATCH_LINE.exec(l));
  if (lines.length === 0 || parsed.some((m) => m === null)) return { text: raw, shaped: false };

  const byFile = new Map<string, string[]>();
  let count = 0;
  for (const m of parsed) {
    if (!m) continue;
    count += 1;
    if (count > MAX_SEARCH_MATCHES) continue;
    const [, , path = "", lineNo = "", text = ""] = m;
    const list = byFile.get(path) ?? [];
    list.push(`  ${lineNo}: ${text.trim()}`);
    byFile.set(path, list);
  }
  const out: string[] = [];
  for (const [path, matches] of byFile) out.push(path, ...matches);
  if (count > MAX_SEARCH_MATCHES) {
    out.push(`[${String(count - MAX_SEARCH_MATCHES)} more matches not shown. Narrow the search.]`);
  }
  return { text: out.join("\n"), shaped: true };
}

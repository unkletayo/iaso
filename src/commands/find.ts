import { type Command, InvalidArgumentError } from "commander";
import { type FindOptions, type FindResult, findIssues } from "../oss/find.js";

export interface FindCommandOptions {
  language?: string;
  minStars: number;
  /** Issues shown. */
  limit: number;
  maxRepos?: number;
  window: number;
  /** Print the result as JSON, for other programs. */
  json?: boolean;
  /** List every repository and issue that was dropped, with the reason. */
  showSkipped?: boolean;
}

export interface FindCommandDeps {
  find: (o: FindOptions) => Promise<FindResult>;
  log: (line: string) => void;
  token: string | undefined;
}

export function defaultFindDeps(): FindCommandDeps {
  return {
    find: findIssues,
    log: (line) => {
      console.log(line);
    },
    token: process.env.GITHUB_TOKEN,
  };
}

/** The result as text for a person. */
export function renderFind(
  result: FindResult,
  o: { limit: number; showSkipped: boolean; hasToken: boolean },
): string {
  const lines: string[] = [];
  const shown = result.candidates.slice(0, o.limit);
  if (shown.length === 0) {
    lines.push("No issue passed the checks.");
  }
  shown.forEach((c, i) => {
    lines.push(
      `${String(i + 1).padStart(2)}. score ${String(c.score)}${c.copyleft ? " [copyleft licence]" : ""}  ${c.url}`,
      `    ${c.title}`,
      `    ${c.reasons.join("; ")}`,
      ...c.claim.warnings.map((w) => `    note: ${w}`),
      "",
    );
  });
  lines.push(
    `Looked at ${String(result.issues)} issue(s) in ${String(result.repos)} project(s); ` +
      `${String(result.candidates.length)} passed, ${String(result.skipped.length)} dropped` +
      `${result.candidates.length > shown.length ? `; showing ${String(shown.length)}` : ""}.`,
  );
  if (o.showSkipped) {
    for (const s of result.skipped) lines.push(`  dropped ${s.what}: ${s.reason}`);
  } else if (result.skipped.length > 0) {
    lines.push("Add --show-skipped to see what was dropped and why.");
  }
  if (!o.hasToken) {
    lines.push(
      "No GITHUB_TOKEN is set, so GitHub allows 10 searches a minute and at most 6 projects were measured.",
    );
  }
  lines.push(
    "",
    "This reads numbers, not rules. It did not read any project's AI policy or contribution",
    "guide, and the score is not a promise that a maintainer will answer. Before you spend",
    "anything: open the issue and the project's CONTRIBUTING file, then run",
    "  iaso run --github <issue url> --max-cost 1",
    "which stops by itself if the project's rules forbid AI-generated contributions.",
  );
  return lines.join("\n");
}

export async function executeFind(opts: FindCommandOptions, deps: FindCommandDeps): Promise<void> {
  const result = await deps.find({
    token: deps.token,
    minStars: opts.minStars,
    windowDays: opts.window,
    ...(opts.language === undefined ? {} : { language: opts.language }),
    ...(opts.maxRepos === undefined ? {} : { maxRepos: opts.maxRepos }),
  });
  if (opts.json) {
    deps.log(
      JSON.stringify({ ...result, candidates: result.candidates.slice(0, opts.limit) }, null, 2),
    );
    return;
  }
  deps.log(
    renderFind(result, {
      limit: opts.limit,
      showSkipped: opts.showSkipped === true,
      hasToken: deps.token !== undefined && deps.token !== "",
    }),
  );
}

function positiveInt(name: string): (value: string) => number {
  return (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new InvalidArgumentError(`${name} must be a whole number above 0.`);
    }
    return n;
  };
}

export function registerFind(
  program: Command,
  deps: () => FindCommandDeps = defaultFindDeps,
): void {
  program
    .command("find")
    .description(
      "Find open starter issues in active projects that take outside contributions (read-only)",
    )
    .option("--language <name>", "only repositories in this language, such as typescript")
    .option("--min-stars <n>", "skip projects with fewer stars", positiveInt("--min-stars"), 200)
    .option("--limit <n>", "how many issues to show", positiveInt("--limit"), 10)
    .option("--max-repos <n>", "how many projects to measure", positiveInt("--max-repos"))
    .option("--window <days>", "days of merged pull requests to count", positiveInt("--window"), 30)
    .option("--json", "print the result as JSON")
    .option("--show-skipped", "list every project and issue that was dropped, with the reason")
    .action(async (opts: FindCommandOptions) => {
      await executeFind(opts, deps());
    });
}

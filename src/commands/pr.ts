import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type { Command } from "commander";
import { z } from "zod";
import { type RunInfo, runInfoSchema } from "../agent/report.js";
import {
  MAX_PRS_PER_REPO_PER_DAY,
  TODO_MARK,
  appendOssLog,
  pushBlockers,
  readOssLog,
  recentPrs,
} from "../oss/limits.js";
import {
  type ClaimReport,
  IssueClaimedError,
  checkIssueClaim,
  claimMessage,
  describeClaim,
} from "../oss/claim.js";
import { type PublishInput, type Published, publish, spawnRunner } from "../oss/publish.js";
import { parseIssueUrl } from "../sources/github.js";

const run = promisify(execFile);

export { TODO_MARK };
export const hasTodo = (text: string): boolean => text.includes(TODO_MARK);

const SUMMARY_CHARS = 2_000;
const TEMPLATE_CHARS = 6_000;
const DRAFT_FILE = "pr-draft.md";

/** The run cannot become a pull request, and why. */
export class PrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrError";
  }
}

/** What `conventions.json` holds (see `oss/conventions.ts`), as far as a pull request needs it. */
const conventionsSchema = z.object({
  commitStyle: z.enum(["conventional"]).nullable(),
  dco: z.boolean(),
  cla: z.boolean(),
  changelog: z.boolean(),
  aiPolicy: z.object({
    verdict: z.enum(["banned", "restricted", "disclosure", "mentioned", "none"]),
    requiresDisclosure: z.boolean(),
    excerpts: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
  }),
  prTemplate: z.object({ path: z.string(), text: z.string() }).nullable(),
});
export type SavedConventions = z.infer<typeof conventionsSchema>;

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

/** The files a unified diff touches, with the lines added and removed in each. */
export function summariseDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header?.[1] !== undefined) {
      current = { path: header[1], added: 0, removed: 0 };
      files.push(current);
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (current !== undefined && inHunk) {
      if (line.startsWith("+")) current.added += 1;
      else if (line.startsWith("-")) current.removed += 1;
    }
  }
  return files;
}

const CONVENTIONAL_TITLE = /^[a-z]+(?:\([^)]*\))?!?: /;

/** Conventional Commits needs a type. "feat" for something new, "fix" otherwise: edit it if wrong. */
function titleFor(
  info: RunInfo,
  conventions: SavedConventions | undefined,
  override: string | undefined,
): string {
  if (override !== undefined) return override.trim();
  // Runs from before prompt 1.0.1 have no PR title; the bug report's title is the best they have.
  const issue = info.prTitle ?? info.issueTitle;
  if (issue === undefined) return `${TODO_MARK}: write a title]`;
  if (conventions?.commitStyle !== "conventional" || CONVENTIONAL_TITLE.test(issue)) return issue;
  const type = /^(?:add|support|implement|introduce|new)\b/i.test(issue) ? "feat" : "fix";
  return `${type}: ${issue.charAt(0).toLowerCase()}${issue.slice(1)}`;
}

export interface Identity {
  name: string;
  email: string;
}

export interface Draft {
  title: string;
  body: string;
  /** Says what the project's rules ask of you, which Iaso cannot do for you. */
  reminders: string[];
  files: ChangedFile[];
}

/**
 * The pull request text for a run. It claims nothing a person has not done: the AI disclosure, the
 * test results and the template's checkboxes are left for the person to confirm or tick.
 */
export function buildDraft(
  info: RunInfo,
  diff: string,
  conventions: SavedConventions | undefined,
  identity: Identity | undefined,
  titleOverride?: string,
): Draft {
  const issueUrl = info.source?.issueUrl;
  if (issueUrl === undefined) throw new PrError("This run did not come from a GitHub issue.");
  const issue = parseIssueUrl(issueUrl);
  const files = summariseDiff(diff);

  // The agent's own test runs are not quoted: they include the run that failed before the fix, and
  // they are unchecked. They are shown to you in the reminders instead.
  const added =
    info.testsAdded.length === 0
      ? "- The agent added no tests."
      : `- Tests added by the agent: ${info.testsAdded.map((t) => `\`${t}\``).join(", ")}.`;

  const sections = [
    (info.prSummary ?? info.summary ?? `${TODO_MARK}: describe the change]`)
      .trim()
      .slice(0, SUMMARY_CHARS),
    `Closes #${String(issue.number)}`,
  ];
  if (info.assumptions.length > 0) {
    sections.push(
      [
        "## Choices the issue did not settle",
        `${TODO_MARK}: check each of these, keep the ones you agree with, and delete the rest]`,
        ...info.assumptions.map((a) => `- ${a}`),
      ].join("\n"),
    );
  }
  sections.push(
    [
      "## Testing",
      added,
      `${TODO_MARK}: run the project's own tests and lint yourself, then replace this line with what you ran and saw]`,
    ].join("\n"),
  );
  if (conventions?.aiPolicy.requiresDisclosure) {
    sections.push(
      [
        "## AI assistance",
        `${TODO_MARK}: confirm this is true, then remove this marker] This change was made with ` +
          `Iaso, an AI coding agent (model ${info.model}), from the issue linked above. Iaso only ` +
          "produced the patch. I reviewed it and ran the tests myself.",
      ].join("\n"),
    );
  }
  if (conventions?.prTemplate) {
    sections.push(
      [
        "## Project checklist (from the pull request template)",
        `${TODO_MARK}: tick only what is true for you. Iaso ticks nothing]`,
        "",
        conventions.prTemplate.text.trim().slice(0, TEMPLATE_CHARS),
      ].join("\n"),
    );
  }

  const reminders: string[] = [
    "Read the diff and run the project's tests yourself before you open the PR. The agent's " +
      "confidence ('" +
      (info.confidence ?? "unknown") +
      "') is its own opinion, and it is not in the draft.",
    info.testsRun.length === 0
      ? "The agent noted no test runs."
      : `The agent noted these test runs (unchecked, and earlier ones may be from before the fix): ${info.testsRun
          .map((t) => `${t.cmd} (${t.result})`)
          .join(", ")}.`,
  ];
  if (conventions === undefined) {
    reminders.push(
      "No conventions.json for this run, so the project's rules were not read. Read its " +
        "CONTRIBUTING file and any AI policy yourself.",
    );
  } else {
    if (conventions.cla) {
      reminders.push(
        "The project mentions a CLA. Only you can sign it, and it must be done before a PR can merge.",
      );
    }
    if (conventions.dco) {
      reminders.push(
        identity
          ? `Every commit needs a Signed-off-by line. It will use your git identity: ${identity.name} <${identity.email}>.`
          : "Every commit needs a Signed-off-by line, but your git name and email are not set. Run `git config --global user.name` and `user.email`.",
      );
    }
    if (conventions.changelog && !files.some((f) => /changelog|\.changeset/i.test(f.path))) {
      reminders.push(
        "The project mentions a changelog or changesets, and this patch adds none. Check whether it wants an entry.",
      );
    }
    if (conventions.aiPolicy.verdict !== "none") {
      reminders.push(
        `AI policy (${conventions.aiPolicy.verdict}${conventions.aiPolicy.requiresDisclosure ? ", disclosure required" : ""}). Read it:`,
        ...conventions.aiPolicy.excerpts.map((e) => `    ${e.path}:${String(e.line)}: ${e.text}`),
      );
    }
  }
  return {
    title: titleFor(info, conventions, titleOverride),
    body: sections.join("\n\n"),
    reminders,
    files,
  };
}

/** The draft as a file: the title on the first line, a blank line, then the body. */
export const renderDraftFile = (d: Pick<Draft, "title" | "body">): string =>
  `${d.title}\n\n${d.body}\n`;

export function parseDraftFile(text: string): { title: string; body: string } {
  const [title = "", ...rest] = text.split("\n");
  return { title: title.trim(), body: rest.join("\n").trim() };
}

export interface PrCommandOptions {
  runs: string;
  title?: string;
  /** Build the draft again even if a file from an earlier call (maybe edited by you) exists. */
  redo?: boolean;
  /** False with `--no-diff`. */
  diff: boolean;
  /** Fork, push and open a draft pull request, after you type the repository's name. */
  push?: boolean;
  /** The commit author, instead of your git name and the GitHub no-reply address. */
  name?: string;
  email?: string;
}

export interface PrCommandDeps {
  /** Your git name and email, if set. */
  gitIdentity: () => Promise<Identity | undefined>;
  log: (line: string) => void;
  /** The current time; tests set it. */
  now?: () => Date;
  /** Who the commit is by: your git name and your GitHub no-reply address, unless overridden. */
  author: (o: { name?: string; email?: string }) => Promise<Identity>;
  /** Read-only look at whether someone else is now on the issue. Run again just before sending. */
  checkClaim: (issueUrl: string) => Promise<ClaimReport>;
  /** Ask a question and return the typed answer; `undefined` when there is no terminal to ask. */
  ask: (question: string) => Promise<string | undefined>;
  publish: (input: PublishInput, log: (line: string) => void) => Promise<Published>;
}

export function defaultPrDeps(): PrCommandDeps {
  return {
    gitIdentity: async () => {
      try {
        const get = async (key: string): Promise<string> =>
          (await run("git", ["config", "--get", key])).stdout.trim();
        const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
        return name && email ? { name, email } : undefined;
      } catch {
        return undefined;
      }
    },
    log: (line) => {
      console.log(line);
    },
    author: async (o) => {
      const config = async (key: string): Promise<string> => {
        try {
          return (await run("git", ["config", "--get", key])).stdout.trim();
        } catch {
          return "";
        }
      };
      const name = o.name ?? (await config("user.name"));
      if (name === "") {
        throw new PrError("No author name. Set `git config --global user.name`, or pass --name.");
      }
      if (o.email !== undefined) return { name, email: o.email };
      try {
        const who = (
          await run("gh", ["api", "user", "--jq", '"\\(.id)+\\(.login)"'])
        ).stdout.trim();
        if (!/^\d+\+[A-Za-z0-9-]+$/.test(who)) throw new Error(who);
        return { name, email: `${who}@users.noreply.github.com` };
      } catch {
        throw new PrError(
          "Could not read your GitHub account with `gh api user`. Log in with `gh auth login`, " +
            "or pass --email.",
        );
      }
    },
    ask: async (question) => {
      if (!process.stdin.isTTY) return undefined;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    publish: (input, log) => publish(input, spawnRunner, log),
    checkClaim: (url) => checkIssueClaim(parseIssueUrl(url), { token: process.env.GITHUB_TOKEN }),
  };
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return schema.parse(JSON.parse(text));
}

/**
 * `iaso pr <runId>`, first step: show what would be sent, and save it as `pr-draft.md` for you to
 * edit. It changes nothing on GitHub and does not use the network.
 */
export async function executePr(
  runId: string,
  opts: PrCommandOptions,
  deps: PrCommandDeps,
): Promise<void> {
  const dir = join(resolve(opts.runs), runId);
  const info = await readJson(join(dir, "run.json"), runInfoSchema);
  if (info === undefined) {
    throw new PrError(
      `No run.json in ${dir}. Check the run id and --runs. A run made by an older Iaso has no ` +
        "run.json: run it again.",
    );
  }
  if (info.status !== "submitted") {
    throw new PrError(
      `This run ended as "${info.status}", not "submitted", so its patch is unfinished work. ` +
        "Read report.md, and run it again if you want a pull request.",
    );
  }
  let diff: string;
  try {
    diff = await readFile(join(dir, "patch.diff"), "utf8");
  } catch {
    diff = "";
  }
  if (diff.trim() === "") throw new PrError("The patch is empty: there is nothing to send.");

  const conventions = await readJson(join(dir, "conventions.json"), conventionsSchema);
  if (conventions?.aiPolicy.verdict === "banned") {
    throw new PrError(
      "This project's rules appear to forbid AI-generated contributions, so no pull request was " +
        "drafted. Read them yourself:\n" +
        conventions.aiPolicy.excerpts
          .map((e) => `  ${e.path}:${String(e.line)}: ${e.text}`)
          .join("\n"),
    );
  }

  const draft = buildDraft(info, diff, conventions, await deps.gitIdentity(), opts.title);
  const draftPath = join(dir, DRAFT_FILE);
  let existing: string | undefined;
  try {
    existing = await readFile(draftPath, "utf8");
  } catch {
    existing = undefined;
  }
  const keep = existing !== undefined && !opts.redo;
  const shown = existing !== undefined && keep ? parseDraftFile(existing) : draft;
  if (!keep) await writeFile(draftPath, renderDraftFile(draft), "utf8");

  const log = deps.log;
  const issue = parseIssueUrl(info.source?.issueUrl ?? "");
  log(`Run ${runId}: ${info.source?.label ?? ""}`);
  log(`Issue:  ${info.source?.issueUrl ?? ""}`);
  log(`Base:   ${info.source?.commit ?? "unknown commit"} of ${issue.owner}/${issue.repo}`);
  log(`Model:  ${info.model}, ${String(info.steps)} steps, $${info.costUsd.toFixed(2)}`);
  log("");
  log(`Files changed (${String(draft.files.length)}):`);
  for (const f of draft.files) log(`  +${String(f.added)} -${String(f.removed)}  ${f.path}`);
  if (opts.diff) log(`\n${diff.trimEnd()}`);
  log("");
  log("Before you open a pull request:");
  for (const r of draft.reminders) log(r.startsWith("    ") ? r : `  - ${r}`);
  log("");
  log(keep ? `Draft (kept from an earlier call; use --redo to rebuild it):` : "Draft:");
  log(`Title: ${shown.title}`);
  log(`\n${shown.body}\n`);
  const todo = (shown.title + shown.body).split(TODO_MARK).length - 1;
  log(
    `${keep ? "Draft file" : "Saved"}: ${draftPath}` +
      (todo > 0
        ? `\n${String(todo)} [TODO] marker(s) left. Edit the file and resolve each one.`
        : ""),
  );

  const repo = `${issue.owner}/${issue.repo}`;
  const entries = await readOssLog(resolve(opts.runs));
  const now = (deps.now ?? (() => new Date()))();
  const blockers = pushBlockers({ repo, runId, todoCount: todo, log: entries, now });
  log("");
  log(
    `Pull requests to ${repo} in the last 24 hours: ${String(recentPrs(entries, repo, now).length)} of ${String(MAX_PRS_PER_REPO_PER_DAY)} allowed.`,
  );
  log(
    blockers.length === 0
      ? "Nothing in the way of opening the pull request."
      : ["Not ready to open:", ...blockers.map((b) => `  - ${b}`)].join("\n"),
  );
  if (!opts.push) {
    log("Nothing was sent to GitHub. Add --push to fork, push and open a draft pull request.");
    return;
  }

  if (blockers.length > 0) throw new PrError("Not pushing: see the list above. Nothing was sent.");
  const baseCommit = info.source?.commit;
  if (baseCommit === undefined) {
    throw new PrError("This run did not record the commit it started from, so it cannot be sent.");
  }
  // Hours may have passed since the run started: look again before asking for the go-ahead.
  const claim = await deps.checkClaim(info.source?.issueUrl ?? "");
  if (claim.blockers.length > 0 || claim.warnings.length > 0) {
    log("");
    log("Is anyone else on this issue? (checked just now)");
    for (const line of describeClaim(claim)) log(line);
  }
  if (claim.blockers.length > 0) {
    throw new IssueClaimedError(claimMessage(claim, "nothing was sent to GitHub"), claim);
  }
  const author = await deps.author({
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.email === undefined ? {} : { email: opts.email }),
  });
  const branch = `iaso/issue-${String(issue.number)}-${(runId.split("-").pop() ?? runId).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const signOff = conventions?.dco === true;
  log("");
  log("About to do this on GitHub:");
  log(`  1. Fork ${repo} to your account (or reuse your fork).`);
  log(
    `  2. Push branch ${branch} to your fork: ${String(draft.files.length)} file(s), one commit.`,
  );
  log(`  3. Open a DRAFT pull request against ${repo}: "${shown.title}"`);
  log(`  Commit author: ${author.name} <${author.email}>${signOff ? " (with Signed-off-by)" : ""}`);
  const answer = await deps.ask(`Type ${repo} to go ahead, or anything else to cancel: `);
  if (answer === undefined) {
    throw new PrError(
      "Sending needs you to type the repository name, and there is no terminal to ask in. " +
        "Nothing was sent.",
    );
  }
  if (answer.trim().toLowerCase() !== repo.toLowerCase()) {
    throw new PrError("Cancelled. Nothing was sent to GitHub.");
  }

  const done = await deps.publish(
    {
      upstream: { owner: issue.owner, repo: issue.repo },
      baseCommit,
      patch: diff,
      branch,
      title: shown.title,
      body: shown.body,
      identity: author,
      signOff,
    },
    log,
  );
  try {
    await appendOssLog(resolve(opts.runs), {
      at: now.toISOString(),
      repo,
      runId,
      prUrl: done.prUrl,
    });
  } catch (err) {
    log(
      `Warning: the pull request is open, but it could not be written to the log, so the daily ` +
        `limit will not count it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log("");
  log(`Opened a draft pull request: ${done.prUrl}`);
  log(
    `Branch ${done.branch} is on ${done.fork}. Review it on GitHub, then mark it ready yourself.`,
  );
}

export function registerPr(program: Command, deps: () => PrCommandDeps = defaultPrDeps): void {
  program
    .command("pr")
    .description(
      "Draft a pull request from a finished run. Changes nothing on GitHub unless you add --push",
    )
    .argument("<runId>", "run folder name under --runs")
    .option("--runs <dir>", "where run folders are", "runs")
    .option("--title <text>", "use this title instead of one made from the issue")
    .option("--redo", "build the draft again, replacing pr-draft.md")
    .option("--no-diff", "do not print the full diff")
    .option(
      "--push",
      "fork, push and open a DRAFT pull request, after you type the repository name",
    )
    .option("--name <name>", "commit author name (default: your git user.name)")
    .option("--email <email>", "commit author email (default: your GitHub no-reply address)")
    .action(async (runId: string, opts: PrCommandOptions) => {
      await executePr(runId, opts, deps());
    });
}

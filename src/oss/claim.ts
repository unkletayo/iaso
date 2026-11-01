import { z } from "zod";
import { type FetchIssueOptions, type IssueRef, getJson } from "../sources/github.js";

/** An open pull request that has seen no activity for this long is treated as abandoned. */
export const STALE_PR_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMELINE_PAGES = 3;
const MAX_COMMENT_PAGES = 2;
const PAGE_SIZE = 100;

/** Why Iaso will not work on an issue, or what to know before it does. */
export interface ClaimReport {
  /** Reasons to stop. There is deliberately no flag that overrides them. */
  blockers: string[];
  /** Things to read before going on. They do not stop the run. */
  warnings: string[];
}

export class IssueClaimedError extends Error {
  constructor(
    message: string,
    readonly report: ClaimReport,
  ) {
    super(message);
    this.name = "IssueClaimedError";
  }
}

const user = z.object({ login: z.string() }).nullable();

const issueSchema = z.object({
  state: z.string(),
  locked: z.boolean().default(false),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  user,
  pull_request: z.unknown().optional(),
});

const sourceIssue = z.object({
  number: z.number(),
  title: z.string().default(""),
  body: z.string().nullable().default(null),
  state: z.string(),
  html_url: z.string(),
  updated_at: z.string(),
  repository_url: z.string().optional(),
  user,
  pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
});

/** Only the parts of the timeline this check reads; any other event type passes through. */
const timelineEvent = z.object({
  event: z.string(),
  source: z.object({ issue: sourceIssue.optional() }).optional(),
});
const commentSchema = z.object({ user, created_at: z.string(), body: z.string().nullable() });

/** "I'll take this", "can I work on this?", "working on it". Keyword matching: it can miss and misread. */
const CLAIM_PHRASE = new RegExp(
  [
    "\\bi(?:'ll| will|'m going to| am going to) (?:take|work on|fix|pick|try|handle|open a pr|submit)\\b",
    "\\b(?:can|may|could) i (?:take|work on|fix|pick|try|have|be assigned)\\b",
    "\\bi(?:'m| am) (?:currently |already )?(?:working on|on) (?:it|this)\\b",
    "(?:^|\\W)working on (?:it|this|a fix|a pr)\\b",
    "\\bassign (?:it |this )?to me\\b",
    "\\blet me (?:take|work on|fix|try)\\b",
  ].join("|"),
  "i",
);

function closes(text: string, ref: IssueRef): boolean {
  const here = `(?:${ref.owner}/${ref.repo})?#${String(ref.number)}\\b`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+${here}`, "i").test(
    text,
  );
}

const sameRepo = (url: string | undefined, ref: IssueRef): boolean =>
  url?.toLowerCase().endsWith(`/repos/${ref.owner}/${ref.repo}`.toLowerCase()) ?? false;

const daysSince = (iso: string, now: Date): number =>
  Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);

async function pages<T>(
  path: string,
  ref: IssueRef,
  o: FetchIssueOptions,
  schema: z.ZodType<T[]>,
  max: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= max; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = schema.parse(
      await getJson(`${path}${sep}per_page=${String(PAGE_SIZE)}&page=${String(page)}`, ref, o),
    );
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Is someone else already on this issue? Read-only. Blockers: closed, locked, assigned, a pull
 * request that says it closes the issue and has been touched lately, or a pull request linked by
 * hand on the issue page. Warnings: an old or merely mentioning pull request, an earlier attempt
 * that was closed, and comments that sound like someone claiming it.
 */
export async function checkIssueClaim(
  ref: IssueRef,
  o: FetchIssueOptions & { now?: Date } = {},
): Promise<ClaimReport> {
  const now = o.now ?? new Date();
  const base = `/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}`;
  const what = `${ref.owner}/${ref.repo}#${String(ref.number)}`;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const issue = issueSchema.parse(await getJson(base, ref, o));
  if (issue.pull_request !== undefined) {
    blockers.push(`${what} is a pull request, not an issue.`);
    return { blockers, warnings };
  }
  if (issue.state !== "open") blockers.push(`${what} is ${issue.state}.`);
  if (issue.locked) blockers.push(`${what} is locked, so only maintainers can comment.`);
  if (issue.assignees.length > 0) {
    blockers.push(`${what} is assigned to ${issue.assignees.map((a) => a.login).join(", ")}.`);
  }

  const timeline = await pages(
    `${base}/timeline`,
    ref,
    o,
    z.array(timelineEvent),
    MAX_TIMELINE_PAGES,
  );
  // A pull request linked by hand shows as "connected"; unlinking shows as "disconnected".
  const linked =
    timeline.filter((e) => e.event === "connected").length -
    timeline.filter((e) => e.event === "disconnected").length;
  if (linked > 0) {
    blockers.push(`A pull request is linked to ${what} on its page. Open the issue and look.`);
  }

  const seen = new Set<number>();
  for (const e of timeline) {
    const pr = e.event === "cross-referenced" ? e.source?.issue : undefined;
    if (
      pr?.pull_request === undefined ||
      !sameRepo(pr.repository_url, ref) ||
      seen.has(pr.number)
    ) {
      continue;
    }
    seen.add(pr.number);
    const who = pr.user?.login ?? "ghost";
    const tag = `#${String(pr.number)} by ${who} (${pr.html_url})`;
    if (pr.state === "open") {
      const idle = daysSince(pr.updated_at, now);
      const says = closes(`${pr.title}\n${pr.body ?? ""}`, ref);
      if (idle >= STALE_PR_DAYS) {
        warnings.push(
          `Open pull request ${tag} mentions this issue but has had no activity for ${String(idle)} days: probably abandoned.`,
        );
      } else if (says) {
        blockers.push(
          `Open pull request ${tag} says it closes this issue (last activity ${String(idle)} day(s) ago).`,
        );
      } else {
        warnings.push(
          `Open pull request ${tag} mentions this issue (last activity ${String(idle)} day(s) ago). Check it is not the same fix.`,
        );
      }
    } else if (pr.pull_request.merged_at) {
      warnings.push(
        `Pull request ${tag} was merged and mentions this issue, which is still open: it may be fixed or partly fixed.`,
      );
    } else {
      warnings.push(`An earlier attempt, pull request ${tag}, was closed without merging.`);
    }
  }

  const comments = await pages(
    `${base}/comments`,
    ref,
    o,
    z.array(commentSchema),
    MAX_COMMENT_PAGES,
  );
  for (const c of comments) {
    const line = (c.body ?? "").split("\n").find((l) => CLAIM_PHRASE.test(l));
    if (line === undefined) continue;
    const who = c.user?.login ?? "ghost";
    warnings.push(`${who} wrote on ${c.created_at.slice(0, 10)}: "${line.trim().slice(0, 160)}"`);
  }
  return { blockers, warnings };
}

export function describeClaim(report: ClaimReport): string[] {
  return [
    ...report.blockers.map((b) => `  stop: ${b}`),
    ...report.warnings.map((w) => `  note: ${w}`),
  ];
}

/** What to tell the person. `consequence` says what did not happen because of the stop. */
export function claimMessage(report: ClaimReport, consequence: string): string {
  return [
    `This issue looks taken, so ${consequence}:`,
    ...report.blockers.map((b) => `  - ${b}`),
    "Maintainers' time is the thing to protect. Pick another issue, or ask on this one first.",
  ].join("\n");
}

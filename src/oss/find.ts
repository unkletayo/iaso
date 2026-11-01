import { z } from "zod";
import { type FetchIssueOptions, type IssueRef, getApi } from "../sources/github.js";
import { type ClaimReport, checkIssueClaim } from "./claim.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A repository with fewer merged pull requests than this in the window is treated as quiet. */
export const MIN_MERGED = 5;
/** ... and one that merged fewer than this many from outside contributors is not taking them. */
export const MIN_EXTERNAL_MERGED = 2;

/** Weights of the score, out of 100. Written down so a ranking can be explained and argued with. */
export const WEIGHTS = { activity: 40, outside: 30, fresh: 10, quiet: 10, stars: 10 } as const;

export interface FindOptions extends FetchIssueOptions {
  /** `typescript`, `python`... Without it, any language. */
  language?: string;
  minStars?: number;
  /** How many repositories to measure. Each costs two API calls, and search is rate limited. */
  maxRepos?: number;
  /** Issues kept per repository. */
  perRepo?: number;
  /** How many top issues get the claim check (three calls each). */
  maxClaims?: number;
  /** Window for "recent activity" in days. */
  windowDays?: number;
  /** Ignore issues not touched for this many days. */
  issueMaxAgeDays?: number;
  now?: Date;
  /** Replaceable in tests. */
  claim?: (ref: IssueRef) => Promise<ClaimReport>;
}

export interface RepoStats {
  fullName: string;
  stars: number;
  license: string | null;
  merged: number;
  externalMerged: number;
}

export interface Candidate {
  url: string;
  repo: RepoStats;
  number: number;
  title: string;
  comments: number;
  updatedAt: string;
  score: number;
  /** Plain-language reasons behind the score. */
  reasons: string[];
  claim: ClaimReport;
}

export interface Skipped {
  what: string;
  reason: string;
}

export interface FindResult {
  candidates: Candidate[];
  skipped: Skipped[];
  /** Repositories measured, and issues the search returned. */
  repos: number;
  issues: number;
}

const user = z.object({ login: z.string(), type: z.string().optional() }).nullable();

const issueItem = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  repository_url: z.string(),
  comments: z.number().default(0),
  updated_at: z.string(),
  assignee: z.unknown().optional(),
  pull_request: z.unknown().optional(),
});
const issueSearch = z.object({ items: z.array(issueItem) });

const repoInfo = z.object({
  full_name: z.string(),
  stargazers_count: z.number(),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  disabled: z.boolean().default(false),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
});

const prItem = z.object({ author_association: z.string(), user });
const prSearch = z.object({ items: z.array(prItem) });

const OUTSIDE = new Set(["NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "CONTRIBUTOR"]);

/** GitHub's own label for the author, so a company's staff with a private membership count as outside. */
export function countMerged(items: z.infer<typeof prSearch>["items"]): {
  merged: number;
  externalMerged: number;
} {
  const people = items.filter((p) => p.user?.type !== "Bot" && !p.user?.login.endsWith("[bot]"));
  return {
    merged: people.length,
    externalMerged: people.filter((p) => OUTSIDE.has(p.author_association)).length,
  };
}

/** Why a repository is not worth a contribution right now, or `undefined` when it is. */
export function repoVerdict(r: RepoStats, minStars: number): string | undefined {
  if (r.license === null || r.license === "NOASSERTION") {
    return "no recognised licence";
  }
  if (r.stars < minStars)
    return `${String(r.stars)} stars is under the ${String(minStars)} minimum`;
  if (r.merged < MIN_MERGED) {
    return `only ${String(r.merged)} pull request(s) merged lately (needs ${String(MIN_MERGED)})`;
  }
  if (r.externalMerged < MIN_EXTERNAL_MERGED) {
    return `only ${String(r.externalMerged)} merged from outside contributors (needs ${String(MIN_EXTERNAL_MERGED)})`;
  }
  return undefined;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Score one issue of a repository that passed `repoVerdict`, 0 to 100, with the reasons. */
export function scoreIssue(
  repo: RepoStats,
  issue: { comments: number; updatedAt: string },
  now: Date,
): { score: number; reasons: string[] } {
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(issue.updatedAt)) / DAY_MS));
  const activity = clamp01(repo.merged / 40) * WEIGHTS.activity;
  const outside = clamp01(repo.externalMerged / 20) * WEIGHTS.outside;
  const fresh = clamp01(1 - age / 180) * WEIGHTS.fresh;
  const quiet = clamp01(1 - issue.comments / 10) * WEIGHTS.quiet;
  const stars = clamp01(Math.log10(Math.max(1, repo.stars)) / 4) * WEIGHTS.stars;
  return {
    score: Math.round(activity + outside + fresh + quiet + stars),
    reasons: [
      `${String(repo.merged)} pull requests merged in the window, ${String(repo.externalMerged)} from outside contributors`,
      `issue last touched ${String(age)} day(s) ago, ${String(issue.comments)} comment(s)`,
      `${String(repo.stars)} stars, licence ${repo.license ?? "unknown"}`,
    ],
  };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

const repoOf = (url: string): string | undefined => /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1];

/**
 * Find open, unassigned "good first issue" issues in projects that are active and take outside
 * contributions, and drop the ones someone is already on. Read-only. It reads the project's
 * numbers, not its rules: the AI policy is read when you run `iaso run --github` on the issue.
 */
export async function findIssues(o: FindOptions = {}): Promise<FindResult> {
  const now = o.now ?? new Date();
  const windowDays = o.windowDays ?? 30;
  const minStars = o.minStars ?? 200;
  // Search allows 10 calls a minute without a token and 30 with one; each repository costs one.
  const maxRepos = o.maxRepos ?? (o.token ? 15 : 8);
  const perRepo = o.perRepo ?? 3;
  const maxClaims = o.maxClaims ?? 10;
  const since = day(new Date(now.getTime() - windowDays * DAY_MS));
  const issuesSince = day(new Date(now.getTime() - (o.issueMaxAgeDays ?? 180) * DAY_MS));
  const skipped: Skipped[] = [];

  const search = (q: string): string =>
    `/search/issues?${new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" }).toString()}`;
  const terms = [
    'label:"good first issue"',
    "state:open",
    "is:issue",
    "no:assignee",
    "archived:false",
    `updated:>=${issuesSince}`,
    ...(o.language ? [`language:${o.language}`] : []),
  ];
  const found = issueSearch.parse(
    await getApi(search(terms.join(" ")), "the issue search", o, "Search"),
  );

  // Group by repository, in the order the search returns them (most recently touched first).
  const byRepo = new Map<string, z.infer<typeof issueItem>[]>();
  for (const item of found.items) {
    const name = repoOf(item.repository_url);
    if (name === undefined || item.pull_request !== undefined) continue;
    byRepo.set(name, [...(byRepo.get(name) ?? []), item]);
  }
  const names = [...byRepo.keys()];
  for (const name of names.slice(maxRepos)) {
    skipped.push({
      what: name,
      reason: `not measured: over the limit of ${String(maxRepos)} repositories`,
    });
  }

  const qualified: { repo: RepoStats; issues: z.infer<typeof issueItem>[] }[] = [];
  for (const name of names.slice(0, maxRepos)) {
    const info = repoInfo.parse(await getApi(`/repos/${name}`, name, o, "Repository"));
    if (info.archived || info.fork || info.disabled) {
      skipped.push({ what: name, reason: "archived, disabled or a fork" });
      continue;
    }
    const prs = prSearch.parse(
      await getApi(search(`repo:${name} is:pr is:merged merged:>=${since}`), name, o, "Repository"),
    );
    const repo: RepoStats = {
      fullName: info.full_name,
      stars: info.stargazers_count,
      license: info.license?.spdx_id ?? null,
      ...countMerged(prs.items),
    };
    const why = repoVerdict(repo, minStars);
    if (why !== undefined) {
      skipped.push({ what: name, reason: why });
      continue;
    }
    qualified.push({ repo, issues: byRepo.get(name) ?? [] });
  }

  const scored: Candidate[] = [];
  for (const { repo, issues } of qualified) {
    const best = issues
      .map((i) => ({
        i,
        ...scoreIssue(repo, { comments: i.comments, updatedAt: i.updated_at }, now),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, perRepo);
    for (const { i, score, reasons } of best) {
      scored.push({
        url: i.html_url,
        repo,
        number: i.number,
        title: i.title,
        comments: i.comments,
        updatedAt: i.updated_at,
        score,
        reasons,
        claim: { blockers: [], warnings: [] },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // The claim check costs three calls per issue, so only the best are checked. The rest are not
  // listed: an unchecked issue must not look like a clear one.
  const claim =
    o.claim ?? ((ref: IssueRef): Promise<ClaimReport> => checkIssueClaim(ref, { ...o, now }));
  const candidates: Candidate[] = [];
  for (const c of scored.slice(0, maxClaims)) {
    const ref = {
      owner: c.repo.fullName.split("/")[0] ?? "",
      repo: c.repo.fullName.split("/")[1] ?? "",
      number: c.number,
    };
    const report = await claim(ref);
    if (report.blockers.length > 0) {
      skipped.push({ what: c.url, reason: report.blockers.join(" ") });
      continue;
    }
    candidates.push({ ...c, claim: report });
  }
  for (const c of scored.slice(maxClaims)) {
    skipped.push({ what: c.url, reason: "not claim-checked: over the limit of issues to check" });
  }
  return { candidates, skipped, repos: names.length, issues: found.items.length };
}

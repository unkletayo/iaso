import { z } from "zod";
import { type FetchIssueOptions, GithubError, type IssueRef, getApi } from "../sources/github.js";
import { type ClaimReport, checkIssueClaim } from "./claim.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A repository with fewer merged pull requests than this in the window is treated as quiet. */
export const MIN_MERGED = 5;
/** ... and one that merged fewer than this many from outside contributors is not taking them. */
export const MIN_EXTERNAL_MERGED = 2;

/** Weights of the score, out of 100. Written down so a ranking can be explained and argued with. */
export const WEIGHTS = {
  activity: 30,
  outside: 20,
  bug: 20,
  fresh: 10,
  quiet: 10,
  stars: 10,
} as const;

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
  /** Pause between search calls, in ms. GitHub refuses a burst of searches. Default 6500 without a token (10 a minute), 3000 with one. */
  searchGapMs?: number;
  /** Replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Told what it is doing, because a paced run takes about a minute. */
  progress?: (line: string) => void;
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
  /** The licence asks that your change be released under the same terms (GPL, AGPL, MPL...). */
  copyleft: boolean;
  /** GitHub could not classify the LICENSE file: read it before you contribute. */
  licenseUnclear: boolean;
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
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).default([]),
  assignee: z.unknown().optional(),
  pull_request: z.unknown().optional(),
});
const issueSearch = z.object({ items: z.array(issueItem) });

const repoItem = z.object({
  full_name: z.string(),
  stargazers_count: z.number(),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  disabled: z.boolean().default(false),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
});
const repoSearch = z.object({ items: z.array(repoItem) });

const prItem = z.object({ author_association: z.string(), user });
/** `total_count` is exact; `items` is only the newest page of up to 100. */
const prSearch = z.object({ total_count: z.number().optional(), items: z.array(prItem) });

const OUTSIDE = new Set(["NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "CONTRIBUTOR"]);

/**
 * Merged pull requests by people, and how many came from outside contributors. GitHub's search
 * returns an exact `total` but only the newest 100 items, so past that the human and outside
 * shares of the sample are scaled up to the total. The author label is GitHub's own, so a
 * company's staff with a private membership count as outside.
 */
export function countMerged(
  items: z.infer<typeof prSearch>["items"],
  total: number = items.length,
): { merged: number; externalMerged: number } {
  const people = items.filter((p) => p.user?.type !== "Bot" && !p.user?.login.endsWith("[bot]"));
  const outside = people.filter((p) => OUTSIDE.has(p.author_association)).length;
  if (total <= items.length || items.length === 0) {
    return { merged: people.length, externalMerged: outside };
  }
  const scale = total / items.length;
  return { merged: Math.round(people.length * scale), externalMerged: Math.round(outside * scale) };
}

/** Why a repository is not worth a contribution right now, or `undefined` when it is. */
export function repoVerdict(r: RepoStats, minStars: number): string | undefined {
  // `NOASSERTION` means a LICENSE file GitHub could not classify, not that there is none. Those
  // projects stay in, flagged, and the person reads the file.
  if (r.license === null) return "no licence file";
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

const labelNames = (labels: z.infer<typeof issueItem>["labels"]): string[] =>
  labels.map((l) => (typeof l === "string" ? l : l.name).toLowerCase());

/** Iaso fixes bugs, so a label that says "bug" is the signal that the work is its kind of work. */
export const isBugLabelled = (labels: readonly string[]): boolean =>
  labels.some((l) => /\b(bug|defect|regression|crash)\b/.test(l));

/** GitHub found a LICENSE file but could not tell which licence it is. */
export const isLicenseUnclear = (license: string | null): boolean => license === "NOASSERTION";

/** A licence that asks for changes to be shared under the same terms. */
export const isCopyleft = (license: string | null): boolean =>
  license !== null && /^(A?GPL|LGPL|MPL|EUPL|OSL|CPL|EPL|SSPL|CC-BY-SA)/i.test(license);

/**
 * Why an issue is not the kind Iaso should take, or `undefined`. Hacktoberfest tasks and "Add new
 * <entry>" requests are data entry, which a bug-fixing agent has no business doing.
 */
export function issueVerdict(issue: {
  title: string;
  labels: readonly string[];
}): string | undefined {
  if (issue.labels.some((l) => l.includes("hacktoberfest"))) {
    return "labelled hacktoberfest: a chore, not a bug";
  }
  if (/^\s*(?:\W+\s*)?(?:add|create)\s+(?:an?\s+)?new\b/i.test(issue.title)) {
    return 'titled "Add new ...": a data-entry request, not a bug';
  }
  return undefined;
}

/** Two titles that differ only in numbers are the same template ("Add new Anime Quote 967"). */
export const titleShape = (title: string): string =>
  title.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** Score one issue of a repository that passed `repoVerdict`, 0 to 100, with the reasons. */
export function scoreIssue(
  repo: RepoStats,
  issue: { comments: number; updatedAt: string; labels?: readonly string[] },
  now: Date,
): { score: number; reasons: string[] } {
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(issue.updatedAt)) / DAY_MS));
  const bug = isBugLabelled(issue.labels ?? []);
  const activity = clamp01(repo.merged / 40) * WEIGHTS.activity;
  const outside = clamp01(repo.externalMerged / 20) * WEIGHTS.outside;
  const bugPoints = bug ? WEIGHTS.bug : 0;
  const fresh = clamp01(1 - age / 180) * WEIGHTS.fresh;
  const quiet = clamp01(1 - issue.comments / 10) * WEIGHTS.quiet;
  const stars = clamp01(Math.log10(Math.max(1, repo.stars)) / 4) * WEIGHTS.stars;
  return {
    score: Math.round(activity + outside + bugPoints + fresh + quiet + stars),
    reasons: [
      `${String(repo.merged)} pull requests merged in the window, ${String(repo.externalMerged)} from outside contributors`,
      bug ? "labelled as a bug" : "not labelled as a bug",
      `issue last touched ${String(age)} day(s) ago, ${String(issue.comments)} comment(s)`,
      `${String(repo.stars)} stars, ${
        isLicenseUnclear(repo.license)
          ? "licence unclear (GitHub could not classify the LICENSE file: read it)"
          : `licence ${repo.license ?? "unknown"}${isCopyleft(repo.license) ? " (copyleft: your change must be released under the same terms)" : ""}`
      }`,
    ],
  };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

const repoOf = (url: string): string | undefined => /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1];

/** How many `repo:` terms one issue search takes (GitHub limits the operators in a query). */
const REPOS_PER_ISSUE_SEARCH = 5;

/**
 * Find open, unassigned "good first issue" issues in projects that are active and take outside
 * contributions, and drop the ones someone is already on. Read-only. It reads the project's
 * numbers, not its rules: the AI policy is read when you run `iaso run --github` on the issue.
 *
 * Projects come first: one repository search returns stars, licence and archived status for up to
 * 100 projects, so tiny, closed and unlicensed ones are dropped before any call is spent on them.
 */
export async function findIssues(o: FindOptions = {}): Promise<FindResult> {
  const now = o.now ?? new Date();
  const windowDays = o.windowDays ?? 30;
  const minStars = o.minStars ?? 200;
  // Search allows 10 calls a minute without a token and 30 with one. A run uses one call for the
  // projects, one per project measured, and one per five projects for their issues.
  const maxRepos = o.maxRepos ?? (o.token ? 10 : 6);
  const perRepo = o.perRepo ?? 3;
  // The claim check is three ordinary calls per issue, and GitHub allows an unauthenticated
  // client only 60 of those an hour, so without a token it checks fewer.
  const maxClaims = o.maxClaims ?? (o.token ? 10 : 5);
  const since = day(new Date(now.getTime() - windowDays * DAY_MS));
  const issuesSince = day(new Date(now.getTime() - (o.issueMaxAgeDays ?? 180) * DAY_MS));
  const skipped: Skipped[] = [];
  const say = o.progress ?? ((): void => undefined);
  const sleep = o.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const gap = o.searchGapMs ?? (o.token ? 3000 : 6500);
  let searches = 0;
  // GitHub's secondary limit refuses a burst of searches even when the per-minute count is fine,
  // and it can trip late in a run. Throwing away the work done so far would be the worst answer,
  // so on that one error: wait as long as GitHub asks, and try the same search once more.
  const paced = async (path: string, what: string, noun: string): Promise<unknown> => {
    if (searches > 0) await sleep(gap);
    searches += 1;
    try {
      return await getApi(path, what, o, noun);
    } catch (err) {
      if (!(err instanceof GithubError) || err.secondaryWaitSeconds === undefined) throw err;
      say(`GitHub asked us to slow down; waiting ${String(err.secondaryWaitSeconds)} seconds...`);
      await sleep(err.secondaryWaitSeconds * 1000);
      return getApi(path, what, o, noun);
    }
  };

  const search = (kind: "issues" | "repositories", q: string): string =>
    `/search/${kind}?${new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" }).toString()}`;

  say("searching for active projects...");
  const projects = repoSearch.parse(
    await paced(
      search(
        "repositories",
        [
          "good-first-issues:>=3",
          `stars:>=${String(minStars)}`,
          `pushed:>=${since}`,
          "archived:false",
          "fork:false",
          ...(o.language ? [`language:${o.language}`] : []),
        ].join(" "),
      ),
      "the project search",
      "Search",
    ),
  );

  // Cheap checks first, from what the one search already told us.
  const toMeasure: z.infer<typeof repoItem>[] = [];
  for (const p of projects.items) {
    const license = p.license?.spdx_id ?? null;
    if (p.archived || p.fork || p.disabled) {
      skipped.push({ what: p.full_name, reason: "archived, disabled or a fork" });
    } else if (license === null) {
      skipped.push({ what: p.full_name, reason: "no licence file" });
    } else if (p.stargazers_count < minStars) {
      skipped.push({
        what: p.full_name,
        reason: `${String(p.stargazers_count)} stars is under the ${String(minStars)} minimum`,
      });
    } else if (toMeasure.length >= maxRepos) {
      skipped.push({
        what: p.full_name,
        reason: `not measured: over the limit of ${String(maxRepos)} repositories`,
      });
    } else {
      toMeasure.push(p);
    }
  }

  const qualified: RepoStats[] = [];
  for (const [n, p] of toMeasure.entries()) {
    say(`measuring ${p.full_name} (${String(n + 1)} of ${String(toMeasure.length)})...`);
    const prs = prSearch.parse(
      await paced(
        search("issues", `repo:${p.full_name} is:pr is:merged merged:>=${since}`),
        p.full_name,
        "Repository",
      ),
    );
    const repo: RepoStats = {
      fullName: p.full_name,
      stars: p.stargazers_count,
      license: p.license?.spdx_id ?? null,
      ...countMerged(prs.items, prs.total_count ?? prs.items.length),
    };
    const why = repoVerdict(repo, minStars);
    if (why === undefined) qualified.push(repo);
    else skipped.push({ what: p.full_name, reason: why });
  }

  // Their open starter issues, five projects to a search.
  const byRepo = new Map<string, z.infer<typeof issueItem>[]>();
  let issueCount = 0;
  for (let i = 0; i < qualified.length; i += REPOS_PER_ISSUE_SEARCH) {
    const group = qualified.slice(i, i + REPOS_PER_ISSUE_SEARCH);
    say("looking for their open starter issues...");
    const found = issueSearch.parse(
      await paced(
        search(
          "issues",
          [
            'label:"good first issue"',
            "state:open",
            "is:issue",
            "no:assignee",
            `updated:>=${issuesSince}`,
            ...group.map((r) => `repo:${r.fullName}`),
          ].join(" "),
        ),
        "the issue search",
        "Search",
      ),
    );
    issueCount += found.items.length;
    for (const item of found.items) {
      const name = repoOf(item.repository_url);
      if (name === undefined || item.pull_request !== undefined) continue;
      byRepo.set(name.toLowerCase(), [...(byRepo.get(name.toLowerCase()) ?? []), item]);
    }
  }
  for (const repo of qualified) {
    if ((byRepo.get(repo.fullName.toLowerCase()) ?? []).length === 0) {
      skipped.push({ what: repo.fullName, reason: "no open, unassigned starter issue now" });
    }
  }

  const scored: Candidate[] = [];
  for (const repo of qualified) {
    const taken: { i: z.infer<typeof issueItem>; labels: string[] }[] = [];
    for (const i of byRepo.get(repo.fullName.toLowerCase()) ?? []) {
      const labels = labelNames(i.labels);
      const why = issueVerdict({ title: i.title, labels });
      if (why === undefined) taken.push({ i, labels });
      else skipped.push({ what: i.html_url, reason: why });
    }
    const ranked = taken
      .map(({ i, labels }) => ({
        i,
        ...scoreIssue(repo, { comments: i.comments, updatedAt: i.updated_at, labels }, now),
      }))
      .sort((a, b) => b.score - a.score);
    // One issue per template, and at most `perRepo` in all.
    const seen = new Map<string, string>();
    const best: typeof ranked = [];
    let repeats = 0;
    for (const r of ranked) {
      const shape = titleShape(r.i.title);
      if (seen.has(shape)) {
        repeats += 1;
        continue;
      }
      seen.set(shape, r.i.html_url);
      if (best.length < perRepo) best.push(r);
    }
    if (repeats > 0) {
      skipped.push({
        what: repo.fullName,
        reason: `${String(repeats)} more issue(s) with the same title pattern as ${[...seen.values()][0] ?? "another"}: one per pattern is enough`,
      });
    }
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
        copyleft: isCopyleft(repo.license),
        licenseUnclear: isLicenseUnclear(repo.license),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // The claim check costs three calls per issue, so only the best are checked. The rest are not
  // listed: an unchecked issue must not look like a clear one.
  const claim =
    o.claim ?? ((ref: IssueRef): Promise<ClaimReport> => checkIssueClaim(ref, { ...o, now }));
  const candidates: Candidate[] = [];
  for (const [n, c] of scored.slice(0, maxClaims).entries()) {
    say(`checking ${c.url} (${String(n + 1)} of ${String(Math.min(maxClaims, scored.length))})...`);
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
  return { candidates, skipped, repos: projects.items.length, issues: issueCount };
}

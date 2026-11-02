import { describe, expect, it, vi } from "vitest";
import {
  MIN_EXTERNAL_MERGED,
  MIN_MERGED,
  type RepoStats,
  WEIGHTS,
  countMerged,
  findIssues,
  isBugLabelled,
  isCopyleft,
  isLicenseUnclear,
  issueVerdict,
  repoVerdict,
  scoreIssue,
  titleShape,
} from "../src/oss/find.js";
import { GithubError } from "../src/sources/github.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

const stats = (over: Partial<RepoStats> = {}): RepoStats => ({
  fullName: "acme/widgets",
  stars: 2000,
  license: "MIT",
  merged: 20,
  externalMerged: 10,
  ...over,
});

describe("countMerged", () => {
  it("leaves out bots and counts GitHub's outside-contributor labels", () => {
    const pr = (assoc: string, login = "p", type = "User") => ({
      author_association: assoc,
      user: { login, type },
    });
    expect(
      countMerged([
        pr("MEMBER"),
        pr("OWNER"),
        pr("CONTRIBUTOR"),
        pr("NONE"),
        pr("FIRST_TIME_CONTRIBUTOR"),
        pr("NONE", "dependabot[bot]", "Bot"),
        pr("NONE", "renovate[bot]"),
        { author_association: "NONE", user: null },
      ]),
    ).toEqual({ merged: 6, externalMerged: 4 });
  });
});

describe("countMerged with an exact total", () => {
  const pr = (assoc: string, bot = false) => ({
    author_association: assoc,
    user: { login: bot ? "x[bot]" : "dev", type: bot ? "Bot" : "User" },
  });

  it("scales a sample of 100 up to the exact total, keeping the shares", () => {
    const sample = [
      ...Array.from({ length: 50 }, () => pr("MEMBER")),
      ...Array.from({ length: 30 }, () => pr("CONTRIBUTOR")),
      ...Array.from({ length: 20 }, () => pr("NONE", true)),
    ];
    // 250 merged in all: 80% of the sample were people, 30% of the sample were outside people.
    expect(countMerged(sample, 250)).toEqual({ merged: 200, externalMerged: 75 });
  });

  it("is exact when the sample holds everything, or when there is no sample", () => {
    expect(countMerged([pr("NONE"), pr("MEMBER")], 2)).toEqual({ merged: 2, externalMerged: 1 });
    expect(countMerged([pr("NONE")])).toEqual({ merged: 1, externalMerged: 1 });
    expect(countMerged([], 40)).toEqual({ merged: 0, externalMerged: 0 });
  });
});

describe("repoVerdict", () => {
  it("accepts a busy, open, licensed project", () => {
    expect(repoVerdict(stats(), 200)).toBeUndefined();
  });

  it("keeps a project whose LICENSE file GitHub could not classify, for a person to read", () => {
    expect(repoVerdict(stats({ license: "NOASSERTION" }), 200)).toBeUndefined();
  });

  it.each([
    [{ license: null }, /no licence file/],
    [{ stars: 50 }, /stars/],
    [{ merged: MIN_MERGED - 1 }, /merged lately/],
    [{ externalMerged: MIN_EXTERNAL_MERGED - 1 }, /outside contributors/],
  ] as const)("refuses %j", (over, reason) => {
    expect(repoVerdict(stats(over), 200)).toMatch(reason);
  });
});

describe("scoreIssue", () => {
  const fresh = { comments: 0, updatedAt: daysAgo(1), labels: ["bug"] };

  it("stays within 100 and reaches it only for a perfect project and a bug issue", () => {
    const best = scoreIssue(stats({ merged: 80, externalMerged: 40, stars: 100000 }), fresh, NOW);
    expect(best.score).toBeLessThanOrEqual(100);
    expect(best.score).toBeGreaterThanOrEqual(98);
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("gives a bug label a fifth of the score, and nothing otherwise", () => {
    const withBug = scoreIssue(stats(), fresh, NOW).score;
    const without = scoreIssue(stats(), { ...fresh, labels: ["enhancement"] }, NOW).score;
    expect(withBug - without).toBe(WEIGHTS.bug);
    expect(scoreIssue(stats(), { comments: 0, updatedAt: daysAgo(1) }, NOW).score).toBe(without);
  });

  it("prefers a busier project, more outside merges, fewer comments and a fresher issue", () => {
    const base = scoreIssue(stats(), fresh, NOW).score;
    expect(scoreIssue(stats({ merged: 40 }), fresh, NOW).score).toBeGreaterThan(base);
    expect(scoreIssue(stats({ externalMerged: 20 }), fresh, NOW).score).toBeGreaterThan(base);
    expect(scoreIssue(stats(), { ...fresh, comments: 8 }, NOW).score).toBeLessThan(base);
    expect(scoreIssue(stats(), { ...fresh, updatedAt: daysAgo(150) }, NOW).score).toBeLessThan(
      base,
    );
  });

  it("explains itself in plain words, including the bug label and a copyleft licence", () => {
    const { reasons } = scoreIssue(
      stats(),
      { comments: 3, updatedAt: daysAgo(4), labels: [] },
      NOW,
    );
    expect(reasons.join("\n")).toContain("20 pull requests merged");
    expect(reasons.join("\n")).toContain("not labelled as a bug");
    expect(reasons.join("\n")).toContain("4 day(s) ago, 3 comment(s)");
    expect(reasons.join("\n")).toContain("licence MIT");
    expect(reasons.join("\n")).not.toContain("copyleft");
    const agpl = scoreIssue(stats({ license: "AGPL-3.0" }), fresh, NOW).reasons.join("\n");
    expect(agpl).toContain("labelled as a bug");
    expect(agpl).toContain("copyleft: your change must be released under the same terms");
  });
});

describe("what kind of issue it is", () => {
  it("recognises bug labels, not words that contain them", () => {
    for (const l of ["bug", "type: bug", "kind/bug", "regression", "crash", "defect"]) {
      expect(isBugLabelled([l]), l).toBe(true);
    }
    for (const l of ["enhancement", "debug", "good first issue", "documentation"]) {
      expect(isBugLabelled([l]), l).toBe(false);
    }
  });

  it("refuses hacktoberfest chores and 'Add new ...' data entry, and nothing else", () => {
    expect(issueVerdict({ title: "Fix it", labels: ["hacktoberfest"] })).toMatch(/hacktoberfest/);
    expect(issueVerdict({ title: "Fix it", labels: ["hacktoberfest-accepted"] })).toMatch(
      /hacktoberfest/,
    );
    for (const t of [
      "Add new Anime Quote 967",
      "🎌 Add new Dialect Entry 721",
      "add a new Japanese idiom",
      "Create new theme",
    ]) {
      expect(issueVerdict({ title: t, labels: [] }), t).toMatch(/data-entry/);
    }
    for (const t of [
      "Add support for X",
      "Crash when adding new items",
      "Newsletter signup fails",
      "Database port exposed",
    ]) {
      expect(issueVerdict({ title: t, labels: ["bug"] }), t).toBeUndefined();
    }
  });

  it("gives titles that differ only in numbers the same shape", () => {
    expect(titleShape("Fix  Quote 967")).toBe(titleShape("fix quote 12"));
    expect(titleShape("Fix quote 967")).not.toBe(titleShape("Fix idiom 967"));
  });

  it("tells an unclassified licence file from no licence", () => {
    expect(isLicenseUnclear("NOASSERTION")).toBe(true);
    for (const l of ["MIT", "AGPL-3.0", null]) expect(isLicenseUnclear(l), String(l)).toBe(false);
    const reasons = scoreIssue(
      stats({ license: "NOASSERTION" }),
      { comments: 0, updatedAt: daysAgo(1) },
      NOW,
    ).reasons;
    expect(reasons.join("\n")).toContain("licence unclear");
    expect(reasons.join("\n")).not.toContain("licence NOASSERTION");
  });

  it("spots copyleft licences, and not permissive ones", () => {
    for (const l of ["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "MPL-2.0", "EUPL-1.2", "CC-BY-SA-4.0"]) {
      expect(isCopyleft(l), l).toBe(true);
    }
    for (const l of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "Unlicense", null]) {
      expect(isCopyleft(l), String(l)).toBe(false);
    }
  });
});

interface Repo {
  stars?: number;
  license?: string | null;
  archived?: boolean;
  fork?: boolean;
  /** Merged PRs by association; defaults to a healthy mix. */
  prs?: { assoc: string; bot?: boolean }[];
  /** The exact number GitHub reports, when it is more than the sample. */
  total?: number;
  issues?: { number: number; comments?: number; age?: number; title?: string; labels?: string[] }[];
}

const healthy: { assoc: string; bot?: boolean }[] = [
  ...Array.from({ length: 12 }, () => ({ assoc: "MEMBER" })),
  ...Array.from({ length: 8 }, () => ({ assoc: "CONTRIBUTOR" })),
];

/** A fake GitHub: project search, PR search and issue search, all by URL, with every query kept. */
function world(repos: Record<string, Repo>) {
  const queries: { kind: string; q: string }[] = [];
  const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
  const fetchFn = vi.fn((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const q = url.searchParams.get("q") ?? "";
    if (url.pathname === "/search/repositories") {
      queries.push({ kind: "repos", q });
      return Promise.resolve(
        json({
          items: Object.entries(repos).map(([name, r]) => ({
            full_name: name,
            stargazers_count: r.stars ?? 3000,
            archived: r.archived ?? false,
            fork: r.fork ?? false,
            license: r.license === null ? null : { spdx_id: r.license ?? "MIT" },
          })),
        }),
      );
    }
    if (url.pathname === "/search/issues" && q.includes("is:pr")) {
      queries.push({ kind: "prs", q });
      const name = /repo:(\S+)/.exec(q)?.[1] ?? "";
      const prs = repos[name]?.prs ?? healthy;
      return Promise.resolve(
        json({
          total_count: repos[name]?.total ?? prs.length,
          items: prs.map((p) => ({
            author_association: p.assoc,
            user: { login: p.bot ? "x[bot]" : "dev", type: p.bot ? "Bot" : "User" },
          })),
        }),
      );
    }
    if (url.pathname === "/search/issues") {
      queries.push({ kind: "issues", q });
      const wanted = [...q.matchAll(/repo:(\S+)/g)].map((m) => m[1] ?? "");
      const items = wanted.flatMap((name) =>
        (repos[name]?.issues ?? [{ number: 1 }]).map((i) => ({
          number: i.number,
          title: i.title ?? `Problem ${String.fromCharCode(96 + i.number)} in ${name}`,
          labels: (i.labels ?? []).map((name) => ({ name })),
          html_url: `https://github.com/${name}/issues/${String(i.number)}`,
          repository_url: `https://api.github.com/repos/${name}`,
          comments: i.comments ?? 1,
          updated_at: daysAgo(i.age ?? 5),
        })),
      );
      return Promise.resolve(json({ items }));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });
  return { fetchFn, queries };
}

const clear = () => Promise.resolve({ blockers: [], warnings: [] });

describe("findIssues", () => {
  it("drops closed, forked, unlicensed and tiny projects from the one project search, with the reason", async () => {
    const w = world({
      "acme/good": {},
      "acme/old": { archived: true },
      "acme/forked": { fork: true },
      "acme/closed": { license: null },
      "acme/tiny": { stars: 10 },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates.map((c) => c.repo.fullName)).toEqual(["acme/good"]);
    const why = Object.fromEntries(r.skipped.map((s) => [s.what, s.reason]));
    expect(why["acme/old"]).toMatch(/archived/);
    expect(why["acme/forked"]).toMatch(/fork/);
    expect(why["acme/closed"]).toMatch(/no licence file/);
    expect(why["acme/tiny"]).toMatch(/stars/);
    expect(r.repos).toBe(5);
    // Nothing was spent measuring the four that failed the cheap checks.
    expect(w.queries.filter((x) => x.kind === "prs")).toHaveLength(1);
  });

  it("asks for projects by stars, activity, state and language, and for PRs merged in the window", async () => {
    const w = world({ "acme/good": {} });
    await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear, language: "python" });
    const repos = w.queries.find((x) => x.kind === "repos")?.q ?? "";
    expect(repos).toContain("good-first-issues:>=3");
    expect(repos).toContain("stars:>=200");
    expect(repos).toContain("pushed:>=2026-10-02");
    expect(repos).toContain("archived:false");
    expect(repos).toContain("fork:false");
    expect(repos).toContain("language:python");
    const prs = w.queries.find((x) => x.kind === "prs")?.q ?? "";
    expect(prs).toContain("repo:acme/good");
    expect(prs).toContain("merged:>=2026-10-02");
    const issues = w.queries.find((x) => x.kind === "issues")?.q ?? "";
    expect(issues).toContain('label:"good first issue"');
    expect(issues).toContain("no:assignee");
    expect(issues).toContain("state:open");
    expect(issues).toContain("updated:>=2026-05-05");
    expect(issues).toContain("repo:acme/good");
  });

  it("uses the exact merged total, not the 100 it can see", async () => {
    const sample = Array.from({ length: 100 }, (_, i) => ({ assoc: i < 50 ? "MEMBER" : "NONE" }));
    const w = world({ "acme/busy": { prs: sample, total: 400 } });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates[0]?.repo).toMatchObject({ merged: 400, externalMerged: 200 });
  });

  it("drops a quiet project, one that takes no outside work, and bots-only activity", async () => {
    const w = world({
      "acme/quiet": { prs: [{ assoc: "MEMBER" }] },
      "acme/insiders": { prs: Array.from({ length: 10 }, () => ({ assoc: "MEMBER" })) },
      "acme/bots": { prs: Array.from({ length: 30 }, () => ({ assoc: "NONE", bot: true })) },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates).toEqual([]);
    const why = Object.fromEntries(r.skipped.map((s) => [s.what, s.reason]));
    expect(why["acme/quiet"]).toMatch(/merged lately/);
    expect(why["acme/insiders"]).toMatch(/outside contributors/);
    expect(why["acme/bots"]).toMatch(/merged lately/);
  });

  it("searches issues only for projects that passed, five to a search", async () => {
    const names = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`o/r${String(i)}`, {}]));
    const w = world({ ...names, "o/quiet": { prs: [] } });
    await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear, maxRepos: 20 });
    const issueSearches = w.queries.filter((x) => x.kind === "issues");
    expect(issueSearches).toHaveLength(2);
    expect(issueSearches[0]?.q.match(/repo:/g)).toHaveLength(5);
    expect(issueSearches[1]?.q.match(/repo:/g)).toHaveLength(2);
    expect(issueSearches.some((x) => x.q.includes("o/quiet"))).toBe(false);
  });

  it("ranks by score, keeps at most `perRepo` issues per project, and prefers quiet fresh issues", async () => {
    const w = world({
      "acme/good": {
        issues: [
          { number: 1, comments: 9, age: 120 },
          { number: 2, comments: 0, age: 2 },
          { number: 3, comments: 1, age: 10 },
          { number: 4, comments: 2, age: 20 },
        ],
      },
    });
    const r = await findIssues({
      fetch: w.fetchFn,
      now: NOW,
      retry: fast,
      claim: clear,
      perRepo: 3,
    });
    expect(r.candidates.map((c) => c.number)).toEqual([2, 3, 4]);
    const scores = r.candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("leaves out hacktoberfest chores and 'Add new ...' requests, with the reason", async () => {
    const w = world({
      "acme/good": {
        issues: [
          { number: 1, title: "Crash on empty input", labels: ["bug"] },
          { number: 2, title: "Add new Anime Quote 967", labels: ["good first issue"] },
          { number: 3, title: "Fix typo", labels: ["hacktoberfest"] },
        ],
      },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates.map((c) => c.number)).toEqual([1]);
    const why = Object.fromEntries(r.skipped.map((s) => [s.what, s.reason]));
    expect(why["https://github.com/acme/good/issues/2"]).toMatch(/data-entry/);
    expect(why["https://github.com/acme/good/issues/3"]).toMatch(/hacktoberfest/);
  });

  it("puts a bug above a feature request of equal standing", async () => {
    const w = world({
      "acme/good": {
        issues: [
          { number: 1, title: "Support dark mode", labels: ["enhancement"] },
          { number: 2, title: "Login fails on Safari", labels: ["bug"] },
        ],
      },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates.map((c) => c.number)).toEqual([2, 1]);
    expect(r.candidates[0]?.score).toBeGreaterThan((r.candidates[1]?.score ?? 0) + 15);
  });

  it("keeps one issue per title pattern and says how many it folded", async () => {
    const w = world({
      "acme/good": {
        issues: [
          { number: 1, title: "Update locale file 12", labels: ["bug"] },
          { number: 2, title: "Update locale file 13", labels: ["bug"], comments: 3 },
          { number: 3, title: "Update locale file 14", labels: ["bug"], comments: 5 },
          { number: 4, title: "Crash on save", labels: ["bug"] },
        ],
      },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates.map((c) => c.number).sort()).toEqual([1, 4]);
    const folded = r.skipped.find((s) => s.what === "acme/good");
    expect(folded?.reason).toMatch(/^2 more issue\(s\) with the same title pattern as .*issues\/1/);
  });

  it("keeps a project with an unclassified licence, flagged, and drops one with no licence file", async () => {
    const w = world({ "acme/other": { license: "NOASSERTION" }, "acme/none": { license: null } });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates.map((c) => [c.repo.fullName, c.licenseUnclear])).toEqual([
      ["acme/other", true],
    ]);
    expect(r.skipped.find((s) => s.what === "acme/none")?.reason).toBe("no licence file");
  });

  it("marks a copyleft project's issues so they are not missed", async () => {
    const w = world({ "acme/agpl": { license: "AGPL-3.0" }, "acme/mit": { license: "MIT" } });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    const by = Object.fromEntries(r.candidates.map((c) => [c.repo.fullName, c.copyleft]));
    expect(by).toEqual({ "acme/agpl": true, "acme/mit": false });
  });

  it("drops an issue someone has taken, keeps warnings, and names the reason", async () => {
    const w = world({ "acme/good": { issues: [{ number: 1 }, { number: 2 }] } });
    const claim = vi.fn((ref: { number: number }) =>
      Promise.resolve(
        ref.number === 1
          ? { blockers: ["acme/good#1 is assigned to sam."], warnings: [] }
          : { blockers: [], warnings: ["an old PR"] },
      ),
    );
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim });
    expect(r.candidates.map((c) => c.number)).toEqual([2]);
    expect(r.candidates[0]?.claim.warnings).toEqual(["an old PR"]);
    expect(r.skipped.find((s) => s.what.endsWith("/issues/1"))?.reason).toContain(
      "assigned to sam",
    );
    expect(claim.mock.calls[0]?.[0]).toMatchObject({ owner: "acme", repo: "good" });
  });

  it("only claim-checks the best issues and does not list the rest as if they were clear", async () => {
    const w = world({ "acme/good": { issues: [{ number: 1 }, { number: 2 }, { number: 3 }] } });
    const claim = vi.fn(clear);
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim, maxClaims: 1 });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(r.candidates).toHaveLength(1);
    expect(r.skipped.filter((s) => s.reason.includes("not claim-checked"))).toHaveLength(2);
  });

  it("measures at most `maxRepos` projects and says which it left out", async () => {
    const w = world({ "a/one": {}, "b/two": {}, "c/three": {} });
    const r = await findIssues({
      fetch: w.fetchFn,
      now: NOW,
      retry: fast,
      claim: clear,
      maxRepos: 2,
    });
    expect(r.candidates.map((c) => c.repo.fullName)).toEqual(["a/one", "b/two"]);
    expect(r.skipped.find((s) => s.what === "c/three")?.reason).toMatch(/over the limit of 2/);
  });

  it("stays inside GitHub's search allowance by default: 10 a minute without a token, 30 with one", async () => {
    const names = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`o/r${String(i)}`, {}]));
    const calls = async (token?: string): Promise<number> => {
      const w = world(names);
      await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear, token });
      return w.queries.length;
    };
    expect(await calls()).toBeLessThanOrEqual(10);
    expect(await calls("t")).toBeLessThanOrEqual(30);
    expect(await calls("t")).toBeGreaterThan(await calls());
  });

  it("checks fewer issues without a token, because unauthenticated GitHub allows 60 ordinary calls an hour", async () => {
    const names = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o/r${String(i)}`, {}]));
    const checked = async (token?: string): Promise<number> => {
      const claim = vi.fn(clear);
      await findIssues({ fetch: world(names).fetchFn, now: NOW, retry: fast, claim, token });
      return claim.mock.calls.length;
    };
    expect(await checked()).toBe(5);
    expect(await checked("t")).toBe(10);
  });

  it("says when a project passed but has no open starter issue left", async () => {
    const w = world({ "acme/empty": { issues: [] } });
    const fetchFn = vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const q = new URL(url).searchParams.get("q") ?? "";
      if (url.includes("/search/issues") && !q.includes("is:pr")) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return w.fetchFn(input);
    });
    const r = await findIssues({ fetch: fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates).toEqual([]);
    expect(r.skipped.find((s) => s.what === "acme/empty")?.reason).toMatch(/no open, unassigned/);
  });

  it("raises GitHub's rate-limit error as it is", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })),
    );
    await expect(findIssues({ fetch: fetchFn, now: NOW, retry: fast })).rejects.toBeInstanceOf(
      GithubError,
    );
    await expect(findIssues({ fetch: fetchFn, now: NOW, retry: fast })).rejects.toThrow(
      /rate limit/,
    );
  });

  it("finds nothing, without error, when the search is empty", async () => {
    const r = await findIssues({ fetch: world({}).fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r).toEqual({ candidates: [], skipped: [], repos: 0, issues: 0 });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  MIN_EXTERNAL_MERGED,
  MIN_MERGED,
  type RepoStats,
  WEIGHTS,
  countMerged,
  findIssues,
  repoVerdict,
  scoreIssue,
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

describe("repoVerdict", () => {
  it("accepts a busy, open, licensed project", () => {
    expect(repoVerdict(stats(), 200)).toBeUndefined();
  });

  it.each([
    [{ license: null }, /licence/],
    [{ license: "NOASSERTION" }, /licence/],
    [{ stars: 50 }, /stars/],
    [{ merged: MIN_MERGED - 1 }, /merged lately/],
    [{ externalMerged: MIN_EXTERNAL_MERGED - 1 }, /outside contributors/],
  ] as const)("refuses %j", (over, reason) => {
    expect(repoVerdict(stats(over), 200)).toMatch(reason);
  });
});

describe("scoreIssue", () => {
  const fresh = { comments: 0, updatedAt: daysAgo(1) };

  it("stays within 100 and reaches it only for a perfect project and issue", () => {
    const best = scoreIssue(stats({ merged: 80, externalMerged: 40, stars: 100000 }), fresh, NOW);
    expect(best.score).toBeLessThanOrEqual(100);
    expect(best.score).toBeGreaterThanOrEqual(98);
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
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

  it("explains itself in plain words", () => {
    const { reasons } = scoreIssue(stats(), { comments: 3, updatedAt: daysAgo(4) }, NOW);
    expect(reasons.join("\n")).toContain("20 pull requests merged");
    expect(reasons.join("\n")).toContain("4 day(s) ago, 3 comment(s)");
    expect(reasons.join("\n")).toContain("licence MIT");
  });
});

interface Repo {
  stars?: number;
  license?: string | null;
  archived?: boolean;
  fork?: boolean;
  /** Merged PRs by association; defaults to a healthy mix. */
  prs?: { assoc: string; bot?: boolean }[];
  issues?: { number: number; comments?: number; age?: number }[];
}

const healthy: { assoc: string; bot?: boolean }[] = [
  ...Array.from({ length: 12 }, () => ({ assoc: "MEMBER" })),
  ...Array.from({ length: 8 }, () => ({ assoc: "CONTRIBUTOR" })),
];

/** A fake GitHub: issue search, PR search and repository lookups, all by URL. */
function world(repos: Record<string, Repo>) {
  const calls: string[] = [];
  const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
  const fetchFn = vi.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === "/search/issues") {
      const q = parsed.searchParams.get("q") ?? "";
      if (q.includes("is:pr")) {
        const name = /repo:(\S+)/.exec(q)?.[1] ?? "";
        const prs = repos[name]?.prs ?? healthy;
        return Promise.resolve(
          json({
            items: prs.map((p) => ({
              author_association: p.assoc,
              user: { login: p.bot ? "x[bot]" : "dev", type: p.bot ? "Bot" : "User" },
            })),
          }),
        );
      }
      const items = Object.entries(repos).flatMap(([name, r]) =>
        (r.issues ?? [{ number: 1 }]).map((i) => ({
          number: i.number,
          title: `${name} issue ${String(i.number)}`,
          html_url: `https://github.com/${name}/issues/${String(i.number)}`,
          repository_url: `https://api.github.com/repos/${name}`,
          comments: i.comments ?? 1,
          updated_at: daysAgo(i.age ?? 5),
        })),
      );
      return Promise.resolve(json({ items }));
    }
    const name = /^\/repos\/([^/]+\/[^/]+)$/.exec(parsed.pathname)?.[1];
    const r = name === undefined ? undefined : repos[name];
    if (name === undefined || r === undefined) {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    return Promise.resolve(
      json({
        full_name: name,
        stargazers_count: r.stars ?? 3000,
        archived: r.archived ?? false,
        fork: r.fork ?? false,
        license: r.license === null ? null : { spdx_id: r.license ?? "MIT" },
      }),
    );
  });
  return { fetchFn, calls };
}

const clear = () => Promise.resolve({ blockers: [], warnings: [] });

describe("findIssues", () => {
  it("keeps only active, licensed, open projects, and says why it dropped the others", async () => {
    const w = world({
      "acme/good": {},
      "acme/quiet": { prs: [{ assoc: "MEMBER" }] },
      "acme/closed": { prs: healthy.slice(0, 5), license: null },
      "acme/old": { archived: true },
      "acme/forked": { fork: true },
      "acme/tiny": { stars: 10 },
      "acme/insiders": { prs: Array.from({ length: 10 }, () => ({ assoc: "MEMBER" })) },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates.map((c) => c.repo.fullName)).toEqual(["acme/good"]);
    const why = Object.fromEntries(r.skipped.map((s) => [s.what, s.reason]));
    expect(why["acme/quiet"]).toMatch(/merged lately/);
    expect(why["acme/closed"]).toMatch(/licence/);
    expect(why["acme/old"]).toMatch(/archived/);
    expect(why["acme/forked"]).toMatch(/fork/);
    expect(why["acme/tiny"]).toMatch(/stars/);
    expect(why["acme/insiders"]).toMatch(/outside contributors/);
    expect(r.repos).toBe(7);
  });

  it("asks GitHub for open, unassigned starter issues in the language, and PRs merged in the window", async () => {
    const w = world({ "acme/good": {} });
    await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear, language: "python" });
    const q = (n: number): string => new URL(w.calls[n] ?? "").searchParams.get("q") ?? "";
    expect(q(0)).toContain('label:"good first issue"');
    expect(q(0)).toContain("no:assignee");
    expect(q(0)).toContain("state:open");
    expect(q(0)).toContain("language:python");
    expect(q(0)).toContain("updated:>=2026-05-05");
    const pr = w.calls.map((_, i) => q(i)).find((x) => x.includes("is:pr")) ?? "";
    expect(pr).toContain("repo:acme/good");
    expect(pr).toContain("merged:>=2026-10-02");
  });

  it("does not count bots as activity", async () => {
    const w = world({
      "acme/bots": { prs: Array.from({ length: 30 }, () => ({ assoc: "NONE", bot: true })) },
    });
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim: clear });
    expect(r.candidates).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/merged lately/);
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
    const w = world({
      "acme/good": { issues: [{ number: 1 }, { number: 2 }, { number: 3 }] },
    });
    const claim = vi.fn(clear);
    const r = await findIssues({ fetch: w.fetchFn, now: NOW, retry: fast, claim, maxClaims: 1 });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(r.candidates).toHaveLength(1);
    expect(r.skipped.filter((s) => s.reason.includes("not claim-checked"))).toHaveLength(2);
  });

  it("measures at most `maxRepos` repositories and says which it left out", async () => {
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

  it("uses a lower default repository limit without a token, because search is rate limited", async () => {
    const names = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o/r${String(i)}`, {}]));
    const noToken = await findIssues({
      fetch: world(names).fetchFn,
      now: NOW,
      retry: fast,
      claim: clear,
    });
    expect(noToken.skipped.filter((s) => s.reason.includes("over the limit of 8"))).toHaveLength(4);
    const withToken = await findIssues({
      fetch: world(names).fetchFn,
      now: NOW,
      retry: fast,
      claim: clear,
      token: "t",
    });
    expect(withToken.skipped.filter((s) => s.reason.includes("repositories"))).toHaveLength(0);
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

import { describe, expect, it, vi } from "vitest";
import { STALE_PR_DAYS, checkIssueClaim, claimMessage, describeClaim } from "../src/oss/claim.js";
import { GithubError } from "../src/sources/github.js";

const ref = { owner: "acme", repo: "widgets", number: 7 };
const NOW = new Date("2026-11-01T12:00:00Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

const issue = (over: Record<string, unknown> = {}) => ({
  state: "open",
  locked: false,
  assignees: [],
  user: { login: "reporter" },
  ...over,
});

const pr = (n: number, over: Record<string, unknown> = {}, merged: string | null = null) => ({
  event: "cross-referenced",
  source: {
    issue: {
      number: n,
      title: `PR ${String(n)}`,
      body: "",
      state: "open",
      html_url: `https://github.com/acme/widgets/pull/${String(n)}`,
      updated_at: daysAgo(3),
      repository_url: "https://api.github.com/repos/acme/widgets",
      user: { login: "contributor" },
      pull_request: { merged_at: merged },
      ...over,
    },
  },
});

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

const comment = (body: string, login = "someone") => ({
  user: { login },
  created_at: "2026-10-20T10:00:00Z",
  body,
});

interface World {
  issue?: Record<string, unknown>;
  timeline?: unknown[];
  comments?: unknown[];
}

/** Answers the three calls the check makes, by URL. */
function check(w: World = {}) {
  const fetchFn = vi.fn((input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.includes("/timeline")) return Promise.resolve(json(w.timeline ?? []));
    if (url.includes("/comments")) return Promise.resolve(json(w.comments ?? []));
    return Promise.resolve(json(w.issue ?? issue()));
  });
  return {
    fetchFn,
    run: () => checkIssueClaim(ref, { fetch: fetchFn, retry: fast, now: NOW }),
  };
}

describe("checkIssueClaim", () => {
  it("has nothing to say about a free, open issue", async () => {
    const { run } = check();
    expect(await run()).toEqual({ blockers: [], warnings: [] });
  });

  it("stops on a closed, locked or assigned issue, and names who", async () => {
    const { blockers } = await check({
      issue: issue({
        state: "closed",
        locked: true,
        assignees: [{ login: "sam" }, { login: "kim" }],
      }),
    }).run();
    expect(blockers).toHaveLength(3);
    expect(blockers.join("\n")).toMatch(/is closed/);
    expect(blockers.join("\n")).toMatch(/locked/);
    expect(blockers.join("\n")).toContain("assigned to sam, kim");
  });

  it("stops on a pull request that says it closes the issue and is recent", async () => {
    for (const body of ["Fixes #7", "closes acme/widgets#7.", "This resolves: #7"]) {
      const { blockers } = await check({ timeline: [pr(20, { body })] }).run();
      expect(blockers, body).toHaveLength(1);
      expect(blockers[0]).toContain("pull/20");
    }
  });

  it("only warns about a pull request that merely mentions the issue", async () => {
    const r = await check({ timeline: [pr(21, { body: "Related to #7, see also #70" })] }).run();
    expect(r.blockers).toEqual([]);
    expect(r.warnings[0]).toContain("mentions this issue");
    // "#70" is another issue, and "fixes #70" must not count as fixing #7.
    const other = await check({ timeline: [pr(22, { body: "Fixes #70" })] }).run();
    expect(other.blockers).toEqual([]);
  });

  it("calls an old open pull request abandoned, even one that says it closes the issue", async () => {
    const r = await check({
      timeline: [pr(23, { body: "Fixes #7", updated_at: daysAgo(STALE_PR_DAYS + 5) })],
    }).run();
    expect(r.blockers).toEqual([]);
    expect(r.warnings[0]).toContain("probably abandoned");
    const edge = await check({
      timeline: [pr(24, { body: "Fixes #7", updated_at: daysAgo(STALE_PR_DAYS - 1) })],
    }).run();
    expect(edge.blockers).toHaveLength(1);
  });

  it("warns about a merged pull request and about a closed attempt", async () => {
    const r = await check({
      timeline: [
        pr(30, { state: "closed" }, "2026-09-01T00:00:00Z"),
        pr(31, { state: "closed" }, null),
      ],
    }).run();
    expect(r.blockers).toEqual([]);
    expect(r.warnings[0]).toContain("was merged");
    expect(r.warnings[1]).toContain("closed without merging");
  });

  it("ignores a pull request in another repository, a plain issue mention, and counts a repeat once", async () => {
    const r = await check({
      timeline: [
        pr(40, { repository_url: "https://api.github.com/repos/other/fork", body: "Fixes #7" }),
        {
          event: "cross-referenced",
          source: { issue: { ...pr(41).source.issue, pull_request: undefined } },
        },
        pr(42, { body: "Fixes #7" }),
        pr(42, { body: "Fixes #7" }),
        { event: "labeled" },
      ],
    }).run();
    expect(r.blockers).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  it("stops on a pull request linked by hand, unless it was unlinked again", async () => {
    expect((await check({ timeline: [{ event: "connected" }] }).run()).blockers).toHaveLength(1);
    const unlinked = await check({
      timeline: [{ event: "connected" }, { event: "disconnected" }],
    }).run();
    expect(unlinked.blockers).toEqual([]);
  });

  it("warns about comments that sound like a claim, quoting the line, and not about others", async () => {
    const r = await check({
      comments: [
        comment("Thanks for the report.\nI'll take this one.", "sam"),
        comment("Can I work on this?"),
        comment("I'm working on it"),
        comment("Please assign this to me"),
        comment("Just click on it and the menu opens."),
        comment("This works on my machine."),
        comment("I tried it and it fails"),
      ],
    }).run();
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings[0]).toContain('sam wrote on 2026-10-20: "I\'ll take this one."');
  });

  it("says a pull request URL is not an issue", async () => {
    const r = await check({ issue: issue({ pull_request: {} }) }).run();
    expect(r.blockers[0]).toContain("is a pull request");
  });

  it("raises GitHub's own error, for example a missing issue", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    await expect(
      checkIssueClaim(ref, { fetch: fetchFn, retry: fast, now: NOW }),
    ).rejects.toBeInstanceOf(GithubError);
  });

  it("sends the token to api.github.com only, in a header", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      seen.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      return Promise.resolve(
        json(url.includes("/timeline") || url.includes("/comments") ? [] : issue()),
      );
    });
    await checkIssueClaim(ref, { fetch: fetchFn, token: "tok", now: NOW });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const { url, auth } of seen) {
      expect(url.startsWith("https://api.github.com/")).toBe(true);
      expect(url).not.toContain("tok");
      expect(auth).toBe("Bearer tok");
    }
  });
});

describe("describeClaim and claimMessage", () => {
  it("prints stops before notes, and the stop message lists only the blockers", () => {
    const report = { blockers: ["it is assigned"], warnings: ["an old PR"] };
    expect(describeClaim(report)).toEqual(["  stop: it is assigned", "  note: an old PR"]);
    const msg = claimMessage(report, "nothing was sent");
    expect(msg).toContain("so nothing was sent:");
    expect(msg).toContain("it is assigned");
    expect(msg).not.toContain("an old PR");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  GithubError,
  MAX_BODY_CHARS,
  MAX_COMMENTS_CHARS,
  MAX_COMMENT_CHARS,
  fetchIssue,
  parseIssueUrl,
  renderIssue,
} from "../src/sources/github.js";

const ref = { owner: "acme", repo: "widgets", number: 7 };
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const issuePayload = (over: Record<string, unknown> = {}) => ({
  title: "sumRange skips the last value",
  state: "open",
  body: "It returns 10 for (1, 5).",
  html_url: "https://github.com/acme/widgets/issues/7",
  user: { login: "reporter" },
  comments: 0,
  labels: [{ name: "bug" }, "help wanted"],
  ...over,
});

const comment = (body: string, login: string | null = "maintainer") => ({
  user: login === null ? null : { login },
  created_at: "2026-10-01T10:00:00Z",
  body,
});

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

/** A fetch that answers by URL and records every call. */
function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(routes[key]?.() ?? new Response("", { status: 500 }));
  });
}

describe("parseIssueUrl", () => {
  it("reads owner, repo and number", () => {
    expect(parseIssueUrl("https://github.com/acme/widgets/issues/7")).toEqual(ref);
    expect(parseIssueUrl(" https://github.com/acme/widgets/issues/7/ ")).toEqual(ref);
    expect(parseIssueUrl("https://github.com/acme/widgets/issues/7#issuecomment-1")).toEqual(ref);
    expect(parseIssueUrl("https://www.github.com/a.b/c_d-e/issues/12")).toEqual({
      owner: "a.b",
      repo: "c_d-e",
      number: 12,
    });
  });

  it("explains pull requests", () => {
    expect(() => parseIssueUrl("https://github.com/acme/widgets/pull/7")).toThrow(/pull request/);
  });

  it.each([
    "not a url",
    "http://github.com/acme/widgets/issues/7",
    "https://gitlab.com/acme/widgets/issues/7",
    "https://github.com.evil.example/acme/widgets/issues/7",
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets/issues",
    "https://github.com/acme/widgets/issues/0",
    "https://github.com/acme/widgets/issues/abc",
    "https://github.com/acme/widgets/issues/7/extra",
    "https://github.com/ac me/widgets/issues/7",
  ])("rejects %s", (url) => {
    expect(() => parseIssueUrl(url)).toThrow(GithubError);
  });
});

describe("fetchIssue", () => {
  it("returns the issue with its comments, labels and a ghost for deleted users", async () => {
    const f = fakeFetch({
      "/comments": () => json([comment("Reproduced."), comment("Same here.", null)]),
      "/issues/7": () => json(issuePayload({ comments: 2 })),
    });
    const issue = await fetchIssue(ref, { fetch: f });
    expect(issue).toMatchObject({
      title: "sumRange skips the last value",
      author: "reporter",
      labels: ["bug", "help wanted"],
      omittedComments: 0,
    });
    expect(issue.comments.map((c) => [c.author, c.body])).toEqual([
      ["maintainer", "Reproduced."],
      ["ghost", "Same here."],
    ]);
  });

  it("sends the token to api.github.com only, and sends none when unset", async () => {
    const f = fakeFetch({ "/issues/7": () => json(issuePayload()) });
    await fetchIssue(ref, { fetch: f, token: "ghp_secret" });
    await fetchIssue(ref, { fetch: f });
    const [with1, without] = [f.mock.calls[0], f.mock.calls[1]];
    expect(urlOf(with1?.[0] ?? "")).toBe("https://api.github.com/repos/acme/widgets/issues/7");
    expect(JSON.stringify(with1?.[1])).toContain("Bearer ghp_secret");
    expect(JSON.stringify(without?.[1])).not.toContain("Authorization");
    for (const call of f.mock.calls)
      expect(urlOf(call[0])).toMatch(/^https:\/\/api\.github\.com\//);
  });

  it("does not ask for comments when there are none", async () => {
    const f = fakeFetch({ "/issues/7": () => json(issuePayload()) });
    await fetchIssue(ref, { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("follows comment pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => comment(`c${String(i)}`));
    const page2 = [comment("last")];
    const f = fakeFetch({
      "&page=1": () => json(page1),
      "&page=2": () => json(page2),
      "/issues/7": () => json(issuePayload({ comments: 101 })),
    });
    const issue = await fetchIssue(ref, { fetch: f });
    expect(issue.comments).toHaveLength(101);
    expect(issue.comments.at(-1)?.body).toBe("last");
  });

  it("cuts long bodies and comments, and counts the comments it leaves out", async () => {
    const big = "x".repeat(MAX_COMMENT_CHARS * 2);
    const many = Array.from({ length: 10 }, () => comment(big));
    const f = fakeFetch({
      "/comments": () => json(many),
      "/issues/7": () =>
        json(issuePayload({ comments: 10, body: "y".repeat(MAX_BODY_CHARS + 50) })),
    });
    const issue = await fetchIssue(ref, { fetch: f });
    expect(issue.body).toContain("[cut: 50 more characters]");
    expect(issue.comments[0]?.body).toContain("[cut:");
    const total = issue.comments.reduce((n, c) => n + c.body.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_COMMENTS_CHARS);
    expect(issue.comments.length + issue.omittedComments).toBe(10);
    expect(issue.omittedComments).toBeGreaterThan(0);
  });

  it("rejects a pull request returned by the issues endpoint", async () => {
    const f = fakeFetch({ "/issues/7": () => json(issuePayload({ pull_request: { url: "x" } })) });
    await expect(fetchIssue(ref, { fetch: f })).rejects.toThrow(/pull request/);
  });

  it("explains 404, with and without a token", async () => {
    const f = fakeFetch({ "/issues/7": () => new Response("{}", { status: 404 }) });
    await expect(fetchIssue(ref, { fetch: f })).rejects.toThrow(/private.*GITHUB_TOKEN/);
    await expect(fetchIssue(ref, { fetch: f, token: "t" })).rejects.toThrow(/token can read/);
  });

  it("explains a bad token and a refusal", async () => {
    const f401 = fakeFetch({ "/issues/7": () => new Response("{}", { status: 401 }) });
    await expect(fetchIssue(ref, { fetch: f401, token: "t" })).rejects.toThrow(
      /rejected GITHUB_TOKEN/,
    );
    const f403 = fakeFetch({ "/issues/7": () => new Response("{}", { status: 403 }) });
    await expect(fetchIssue(ref, { fetch: f403 })).rejects.toThrow(/refused access/);
  });

  it("says why GitHub refused, in GitHub's own words, when it gives a reason", async () => {
    const body = JSON.stringify({ message: "Resource not accessible by personal access token" });
    const f = fakeFetch({ "/issues/7": () => new Response(body, { status: 403 }) });
    await expect(fetchIssue(ref, { fetch: f })).rejects.toThrow(
      /refused access to acme\/widgets#7 \(403\): Resource not accessible by personal access token/,
    );
  });

  it("recognises GitHub's secondary rate limit by its header or its words, and does not retry it", async () => {
    const byHeader = fakeFetch({
      "/issues/7": () => new Response("{}", { status: 403, headers: { "retry-after": "45" } }),
    });
    await expect(fetchIssue(ref, { fetch: byHeader, retry: fast })).rejects.toThrow(
      /secondary rate limit.*Wait 45 seconds/,
    );
    expect(byHeader).toHaveBeenCalledTimes(1);
    const waits = await fetchIssue(ref, { fetch: byHeader, retry: fast }).catch(
      (e: unknown) => (e as GithubError).secondaryWaitSeconds,
    );
    expect(waits).toBe(45);
    const noWait = fakeFetch({
      "/issues/7": () =>
        new Response(JSON.stringify({ message: "secondary rate limit" }), { status: 403 }),
    });
    await expect(fetchIssue(ref, { fetch: noWait, retry: fast })).rejects.toThrow(
      /too fast\)\. Wait a minute, then run again\.$/,
    );
    const byWords = fakeFetch({
      "/issues/7": () =>
        new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
          status: 403,
        }),
    });
    await expect(fetchIssue(ref, { fetch: byWords, retry: fast })).rejects.toThrow(
      /secondary rate limit/,
    );
    expect(byWords).toHaveBeenCalledTimes(1);
  });

  it("reports a rate limit with the reset time, and does not retry it", async () => {
    const f = fakeFetch({
      "/issues/7": () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" },
        }),
    });
    await expect(fetchIssue(ref, { fetch: f, retry: fast })).rejects.toThrow(
      /rate limit.*Resets at 2026-.*GITHUB_TOKEN/,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a server error, then succeeds", async () => {
    let calls = 0;
    const f = fakeFetch({
      "/issues/7": () => (++calls < 3 ? new Response("", { status: 502 }) : json(issuePayload())),
    });
    const issue = await fetchIssue(ref, { fetch: f, retry: fast });
    expect(issue.title).toContain("sumRange");
    expect(calls).toBe(3);
  });

  it("never puts the token in an error message", async () => {
    const f = fakeFetch({ "/issues/7": () => new Response("{}", { status: 404 }) });
    await expect(fetchIssue(ref, { fetch: f, token: "ghp_secret" })).rejects.not.toThrow(
      /ghp_secret/,
    );
  });
});

describe("renderIssue", () => {
  const issue = {
    ...ref,
    url: "https://github.com/acme/widgets/issues/7",
    title: "sumRange skips the last value",
    state: "open",
    author: "reporter",
    labels: ["bug"],
    body: "It returns 10 for (1, 5).",
    comments: [{ author: "maintainer", createdAt: "2026-10-01T10:00:00Z", body: "Reproduced." }],
    omittedComments: 3,
  };

  it("renders title, source, body and comments", () => {
    const out = renderIssue(issue);
    expect(out).toContain("# sumRange skips the last value");
    expect(out).toContain("acme/widgets#7 (open) by reporter, labels: bug");
    expect(out).toContain("It returns 10 for (1, 5).");
    expect(out).toContain("**maintainer** (2026-10-01T10:00:00Z):\n\nReproduced.");
    expect(out).toContain("[3 more comments are not shown.]");
  });

  it("says when there is no description and leaves out empty parts", () => {
    const out = renderIssue({ ...issue, body: " ", labels: [], comments: [], omittedComments: 0 });
    expect(out).toContain("(no description)");
    expect(out).not.toContain("labels:");
    expect(out).not.toContain("more comments");
  });
});

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloneError, type GitRunner, githubSource } from "../src/sources/github.js";

const ISSUE_URL = "https://github.com/acme/widgets/issues/7";

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const fetchIssueOnly = vi.fn((input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.endsWith("/issues/7")) {
    return Promise.resolve(
      json({
        title: "sumRange skips the last value",
        state: "open",
        body: "returns 10",
        html_url: ISSUE_URL,
        user: { login: "reporter" },
        comments: 0,
        labels: [],
      }),
    );
  }
  throw new Error(`unexpected request: ${url}`);
});

/** A small git repo with three commits, to clone from. */
async function originRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iaso-origin-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  for (const n of [1, 2, 3]) {
    await writeFile(join(dir, "a.txt"), `v${String(n)}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `c${String(n)}`);
  }
  return dir;
}

describe("githubSource", () => {
  it(
    "fetches the issue and clones the repo with the history depth asked for",
    { timeout: 30_000 },
    async () => {
      const origin = await originRepo();
      const src = await githubSource(ISSUE_URL, {
        fetch: fetchIssueOnly as unknown as typeof fetch,
        cloneUrl: () => `file://${origin}`,
        depth: 2,
      });
      try {
        expect(src.label).toBe("acme/widgets#7");
        expect(src.issueUrl).toBe(ISSUE_URL);
        expect(src.issue).toContain("# sumRange skips the last value");
        expect(await readFile(join(src.repoPath, "a.txt"), "utf8")).toBe("v3\n");
        expect(src.commit).toMatch(/^[0-9a-f]{40}$/);
        const log = execFileSync("git", ["-C", src.repoPath, "log", "--format=%s"], {
          encoding: "utf8",
        });
        expect(log.trim().split("\n")).toEqual(["c3", "c2"]);
      } finally {
        await src.cleanup();
      }
      expect(existsSync(src.repoPath)).toBe(false);
      await expect(src.cleanup()).resolves.toBeUndefined();
    },
  );

  it("gives git the token through the environment only, and only for github.com", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const git: GitRunner = (args, opts) => {
      calls.push({ args, env: opts.env });
      return Promise.resolve(args[0] === "rev-parse" ? "abc123\n" : "");
    };
    const src = await githubSource(ISSUE_URL, {
      fetch: fetchIssueOnly as unknown as typeof fetch,
      token: "ghp_secret",
      git,
    });
    await src.cleanup();
    const clone = calls[0];
    expect(clone?.args.slice(0, 5)).toEqual(["clone", "--depth", "50", "--single-branch", "--"]);
    expect(clone?.args).toContain("https://github.com/acme/widgets.git");
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain("ghp_secret");
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(
      Buffer.from("x-access-token:ghp_secret").toString("base64"),
    );
    expect(clone?.env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(clone?.env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`,
    );
    expect(clone?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(src.commit).toBe("abc123");
  });

  it("sends no auth header without a token, and none to a custom clone URL", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const git: GitRunner = (_args, opts) => {
      seen.push(opts.env);
      return Promise.resolve("abc\n");
    };
    const fetchOpt = fetchIssueOnly as unknown as typeof fetch;
    await (await githubSource(ISSUE_URL, { fetch: fetchOpt, git })).cleanup();
    await (
      await githubSource(ISSUE_URL, {
        fetch: fetchOpt,
        git,
        token: "ghp_secret",
        cloneUrl: () => "file:///elsewhere",
      })
    ).cleanup();
    for (const env of seen) expect(env.GIT_CONFIG_COUNT).not.toBe("1");
  });

  it("removes the folder and hides the token when the clone fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "iaso-root-"));
    const git: GitRunner = () =>
      Promise.reject(
        new Error(
          "fatal: auth failed for ghp_secret (header eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==)",
        ),
      );
    const err = await githubSource(ISSUE_URL, {
      fetch: fetchIssueOnly as unknown as typeof fetch,
      token: "ghp_secret",
      git,
      tmpRoot: root,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneError);
    expect((err as Error).message).toContain("Could not clone acme/widgets");
    expect((err as Error).message).not.toContain("ghp_secret");
    expect((err as Error).message).not.toContain("eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==");
    expect((err as Error).message).toContain("[token]");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not clone when the issue cannot be read", async () => {
    const git = vi.fn<GitRunner>(() => Promise.resolve(""));
    const notFound = vi.fn(() => Promise.resolve(new Response("{}", { status: 404 })));
    await expect(
      githubSource(ISSUE_URL, { fetch: notFound as unknown as typeof fetch, git }),
    ).rejects.toThrow(/Issue not found/);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects a bad URL before any request", async () => {
    const f = vi.fn();
    await expect(
      githubSource("https://github.com/acme/widgets/pull/7", {
        fetch: f as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/pull request/);
    expect(f).not.toHaveBeenCalled();
  });
});

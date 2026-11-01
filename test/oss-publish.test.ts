import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type CmdResult,
  type PublishInput,
  PublishError,
  type Runner,
  publish,
  spawnRunner,
} from "../src/oss/publish.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const UPSTREAM_URL = "https://github.com/acme/widgets.git";
const FORK_URL = "https://github.com/ada/widgets.git";
const PR_URL = "https://github.com/acme/widgets/pull/9";

interface Call {
  command: string;
  args: readonly string[];
}

interface World {
  upstream: string;
  fork: string;
  /** A fork that lacks the base commit (forked long ago, never synced). */
  stale: string;
  baseCommit: string;
}

let world: World;

/** A one-commit "upstream" repo, and an empty bare repo standing in for the fork. */
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "iaso-pub-"));
  const upstream = join(root, "upstream");
  const fork = join(root, "fork.git");
  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  await writeFile(join(upstream, "a.txt"), "one\ntwo\n");
  git(upstream, "add", "-A");
  git(
    upstream,
    "-c",
    "user.name=Up",
    "-c",
    "user.email=up@example.com",
    "commit",
    "-q",
    "-m",
    "init",
  );
  // A fresh fork already holds the project's history.
  execFileSync("git", ["clone", "-q", "--bare", upstream, fork]);
  const stale = join(root, "stale.git");
  execFileSync("git", ["init", "-q", "--bare", stale]);
  world = { upstream, fork, stale, baseCommit: git(upstream, "rev-parse", "HEAD") };
});

const PATCH =
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n";

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  upstream: { owner: "acme", repo: "widgets" },
  baseCommit: world.baseCommit,
  patch: PATCH,
  branch: "fix/upper",
  title: "fix: upper-case one",
  body: "Makes it ONE.\n\nCloses #1",
  identity: { name: "Ada", email: "1+ada@users.noreply.github.com" },
  signOff: false,
  ...over,
});

/**
 * Real `git` against local folders (the GitHub URLs are mapped to them); `gh` is a script. The
 * calls are recorded, so a test can say what was and was not done.
 */
function runner(opts: { parent?: string; failGh?: string; fork?: string } = {}): {
  run: Runner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const ok = (stdout = ""): Promise<CmdResult> =>
    Promise.resolve({ exitCode: 0, stdout, stderr: "" });
  const run: Runner = (command, args, o) => {
    calls.push({ command, args });
    if (command === "gh") {
      const a = args.join(" ");
      if (opts.failGh !== undefined && a.startsWith(opts.failGh)) {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "gh says no" });
      }
      if (a.startsWith("api user")) return ok("ada\n");
      if (a.includes("defaultBranchRef")) return ok("main\n");
      if (a.startsWith("repo fork")) return ok();
      if (a.includes("--json parent")) return ok(`${opts.parent ?? "acme/widgets"}\n`);
      if (a.startsWith("pr create")) return ok(`Creating draft pull request...\n${PR_URL}\n`);
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: `unexpected gh ${a}` });
    }
    const mapped = args.map((x) =>
      x === UPSTREAM_URL
        ? `file://${world.upstream}`
        : x === FORK_URL
          ? `file://${opts.fork ?? world.fork}`
          : x,
    );
    // The credential helper is for GitHub; a local folder needs none.
    return spawnRunner(command, mapped, o);
  };
  return { run, calls };
}

describe("publish", { timeout: 30_000 }, () => {
  it("commits the patch on the base commit, pushes it to the fork, and opens a draft", async () => {
    const { run, calls } = runner();
    const out = await publish(input({ signOff: true }), run);

    expect(out).toMatchObject({ prUrl: PR_URL, fork: "ada/widgets", branch: "fix/upper" });
    expect(git(world.fork, "rev-parse", "fix/upper")).toBe(out.commit);
    expect(git(world.fork, "show", "fix/upper:a.txt")).toBe("ONE\ntwo");
    expect(git(world.fork, "log", "-1", "--format=%an <%ae>", "fix/upper")).toBe(
      "Ada <1+ada@users.noreply.github.com>",
    );
    const message = git(world.fork, "log", "-1", "--format=%B", "fix/upper");
    expect(message).toContain("fix: upper-case one");
    expect(message).toContain("Signed-off-by: Ada <1+ada@users.noreply.github.com>");
    expect(git(world.fork, "rev-parse", "fix/upper^")).toBe(world.baseCommit);

    const create = calls.find((c) => c.args.join(" ").startsWith("pr create"));
    expect(create?.args).toEqual(
      expect.arrayContaining(["--draft", "--base", "main", "--head", "ada:fix/upper"]),
    );
    // The push borrows gh's credentials for that command only.
    const push = calls.find((c) => c.args.includes("push"));
    expect(push?.args).toEqual(
      expect.arrayContaining(["credential.helper=!gh auth git-credential"]),
    );
  });

  it("adds no Signed-off-by line unless the project asks for one", async () => {
    await publish(input(), runner().run);
    expect(git(world.fork, "log", "-1", "--format=%B", "fix/upper")).not.toContain("Signed-off-by");
  });

  it("stops before touching GitHub when the patch does not apply", async () => {
    const { run, calls } = runner();
    const bad = PATCH.replace("-one", "-nope");
    await expect(publish(input({ patch: bad }), run)).rejects.toMatchObject({
      name: "PublishError",
      step: "patch check",
    });
    expect(calls.some((c) => c.args.includes("fork") || c.args.includes("push"))).toBe(false);
    expect(git(world.fork, "branch", "--list")).not.toContain("fix/upper");
  });

  it("refuses to push to a repository that is not a fork of the project", async () => {
    const { run, calls } = runner({ parent: "someone/else" });
    await expect(publish(input(), run)).rejects.toMatchObject({ step: "fork check" });
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
    expect(calls.some((c) => c.args.join(" ").startsWith("pr create"))).toBe(false);
    expect(git(world.fork, "branch", "--list")).not.toContain("fix/upper");
  });

  it("tells you to sync a fork that is too old to take the commit, and opens nothing", async () => {
    const { run, calls } = runner({ fork: world.stale });
    const err = await publish(input(), run).catch((e: unknown) => e);
    expect((err as PublishError).step).toBe("push");
    expect((err as PublishError).message).toContain("gh repo sync ada/widgets");
    expect(calls.some((c) => c.args.join(" ").startsWith("pr create"))).toBe(false);
  });

  it("refuses text that still has a [TODO marker, before running anything", async () => {
    const { run, calls } = runner();
    await expect(publish(input({ body: "[TODO: tests] x" }), run)).rejects.toBeInstanceOf(
      PublishError,
    );
    await expect(publish(input({ title: "[TODO: title]" }), run)).rejects.toBeInstanceOf(
      PublishError,
    );
    expect(calls).toEqual([]);
  });

  it("reports which step failed, with the program's own message, and opens nothing", async () => {
    const { run, calls } = runner({ failGh: "repo fork" });
    const err = await publish(input(), run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).step).toBe("fork");
    expect((err as PublishError).message).toContain("gh says no");
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("says where the branch is when gh prints no pull request URL", async () => {
    const calls: Call[] = [];
    const base = runner();
    const run: Runner = async (command, args, o) => {
      calls.push({ command, args });
      if (command === "gh" && args[0] === "pr")
        return { exitCode: 0, stdout: "done\n", stderr: "" };
      return base.run(command, args, o);
    };
    await expect(publish(input(), run)).rejects.toThrow(/was pushed to ada\/widgets/);
  });
});

describe("spawnRunner", () => {
  it("returns output and exit code, and treats a missing program as 127", async () => {
    expect(await spawnRunner("git", ["--version"], {})).toMatchObject({ exitCode: 0 });
    expect(await spawnRunner("git", ["no-such-command"], {})).toMatchObject({ exitCode: 1 });
    expect((await spawnRunner("iaso-no-such-program", [], {})).exitCode).toBe(127);
  });
});

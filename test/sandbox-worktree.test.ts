import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorktreeSandbox } from "../src/sandbox/worktree.js";

// ── helpers ──────────────────────────────────────────────────────────────────

async function git(cmd: string, cwd: string): Promise<string> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const { stdout } = await execAsync(`git ${cmd}`, { cwd });
  return stdout.trim();
}

async function createRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iaso-wt-repo-"));
  await git("init", dir);
  await git("config user.email test@test.com", dir);
  await git("config user.name Test", dir);
  // create an initial file so there is always a commit
  await writeFile(join(dir, "README.md"), "hello");
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await git("add -A", dir);
  await git('commit --no-gpg-sign -m init', dir);
  return dir;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

let repoDir = "";
let sandbox: WorktreeSandbox;

beforeEach(async () => {
  repoDir = await createRepo({ "src/index.ts": "export const x = 1;\n" });
  sandbox = new WorktreeSandbox({ repoPath: repoDir, runId: "test" });
});

afterEach(async () => {
  await sandbox.destroy();
  await rm(repoDir, { recursive: true, force: true });
});

// ── start / destroy ───────────────────────────────────────────────────────────

describe("WorktreeSandbox lifecycle", () => {
  it("start creates a worktree listing in the original repo", async () => {
    await sandbox.start();
    const list = await git("worktree list", repoDir);
    expect(list.split("\n").length).toBeGreaterThan(1);
  });

  it("throws if started twice", async () => {
    await sandbox.start();
    await expect(sandbox.start()).rejects.toThrow("already started");
  });

  it("destroy removes the worktree so git worktree list shows only the main one", async () => {
    await sandbox.start();
    await sandbox.destroy();
    const list = await git("worktree list", repoDir);
    expect(list.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("destroy is idempotent", async () => {
    await sandbox.start();
    await sandbox.destroy();
    await expect(sandbox.destroy()).resolves.not.toThrow();
  });

  it("destroy before start is a no-op", async () => {
    await expect(sandbox.destroy()).resolves.not.toThrow();
  });
});

// ── exec ──────────────────────────────────────────────────────────────────────

describe("WorktreeSandbox.exec", () => {
  beforeEach(() => sandbox.start());

  it("runs a command and captures stdout", async () => {
    const r = await sandbox.exec("echo hello");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("captures stderr", async () => {
    const r = await sandbox.exec("echo err >&2");
    expect(r.stderr.trim()).toBe("err");
  });

  it("returns non-zero exit code on failure", async () => {
    const r = await sandbox.exec("exit 42");
    expect(r.exitCode).toBe(42);
  });

  it("maps /repo to the worktree so agent commands work", async () => {
    const r = await sandbox.exec("ls /repo/src");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("index.ts");
  });

  it("times out and returns exitCode 124", async () => {
    const r = await sandbox.exec("sleep 60", { timeoutSec: 1 });
    expect(r.exitCode).toBe(124);
    expect(r.timedOut).toBe(true);
  }, 10000);

  it("throws when called after destroy", async () => {
    await sandbox.destroy();
    await expect(sandbox.exec("echo hi")).rejects.toThrow("not running");
  });
});

// ── readFile / writeFile ──────────────────────────────────────────────────────

describe("WorktreeSandbox.readFile / writeFile", () => {
  beforeEach(() => sandbox.start());

  it("reads an existing file via /repo path", async () => {
    const content = await sandbox.readFile("/repo/src/index.ts");
    expect(content).toBe("export const x = 1;\n");
  });

  it("throws on a missing file", async () => {
    await expect(sandbox.readFile("/repo/does-not-exist.ts")).rejects.toThrow();
  });

  it("writes a new file and reads it back", async () => {
    await sandbox.writeFile("/repo/src/new.ts", "export const y = 2;\n");
    const content = await sandbox.readFile("/repo/src/new.ts");
    expect(content).toBe("export const y = 2;\n");
  });

  it("writeFile creates intermediate directories", async () => {
    await sandbox.writeFile("/repo/a/b/c/deep.ts", "deep");
    const content = await sandbox.readFile("/repo/a/b/c/deep.ts");
    expect(content).toBe("deep");
  });

  it("write in the worktree does not touch the original repo", async () => {
    await sandbox.writeFile("/repo/src/index.ts", "changed");
    const original = await readFile(join(repoDir, "src/index.ts"), "utf8");
    expect(original).toBe("export const x = 1;\n");
  });

  it("throws on a path that escapes the sandbox", async () => {
    await expect(sandbox.readFile("/etc/passwd")).rejects.toThrow("escapes");
  });
});

// ── diff ──────────────────────────────────────────────────────────────────────

describe("WorktreeSandbox.diff", () => {
  beforeEach(() => sandbox.start());

  it("returns empty string when nothing changed", async () => {
    const d = await sandbox.diff();
    expect(d).toBe("");
  });

  it("includes a modified file in the diff", async () => {
    await sandbox.writeFile("/repo/src/index.ts", "export const x = 99;\n");
    const d = await sandbox.diff();
    expect(d).toContain("src/index.ts");
    expect(d).toContain("+export const x = 99;");
  });

  it("includes a new file in the diff", async () => {
    await sandbox.writeFile("/repo/src/new.ts", "new file\n");
    const d = await sandbox.diff();
    expect(d).toContain("src/new.ts");
  });

  it("still diffs from the original HEAD if the agent commits inside the worktree", async () => {
    await sandbox.writeFile("/repo/src/index.ts", "changed\n");
    await sandbox.exec(
      "git add -A && git -c user.email=a@b.com -c user.name=A commit --no-gpg-sign -m wip",
    );
    const d = await sandbox.diff();
    expect(d).toContain("src/index.ts");
  });
});

// ── setNetwork ────────────────────────────────────────────────────────────────

describe("WorktreeSandbox.setNetwork", () => {
  it("is a no-op and does not throw", async () => {
    await sandbox.start();
    await expect(sandbox.setNetwork(true)).resolves.not.toThrow();
    await expect(sandbox.setNetwork(false)).resolves.not.toThrow();
  });
});

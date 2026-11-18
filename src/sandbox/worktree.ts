import { spawn } from "node:child_process";
import {
  rm,
  mkdir,
  writeFile as fsWriteFile,
  readFile as fsReadFile,
  mkdtemp,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { REPO_DIR } from "./images.js";
import type { ExecOptions, ExecResult, Sandbox } from "./types.js";

const DEFAULT_TIMEOUT_SEC = 120;
/** Cap stdout/stderr so a runaway command cannot exhaust host memory. */
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

export interface WorktreeSandboxOptions {
  repoPath: string;
  runId: string;
}

/**
 * A sandbox that creates a git worktree on the host and runs commands directly.
 * No Docker required. Requires a git repo at `repoPath`.
 *
 * Path convention: tools pass paths like `/repo/src/foo.ts`; WorktreeSandbox maps
 * the `/repo` prefix to the worktree root so the same tools work without modification.
 */
export class WorktreeSandbox implements Sandbox {
  private worktreePath: string | undefined;
  private baseCommit: string | undefined;
  private destroyed = false;

  constructor(private readonly opts: WorktreeSandboxOptions) {}

  async start(): Promise<void> {
    if (this.worktreePath !== undefined) throw new Error("Sandbox already started");

    const shaResult = await runInDir("git rev-parse HEAD", this.opts.repoPath);
    if (shaResult.exitCode !== 0) {
      throw new Error(
        `Cannot resolve HEAD in ${this.opts.repoPath}: ${shaResult.stderr.trim() || shaResult.stdout.trim()}`,
      );
    }

    const tmpDir = await mkdtemp(join(tmpdir(), `iaso-wt-${this.opts.runId}-`));
    try {
      const result = await runInDir(
        `git worktree add --detach ${sq(tmpDir)} HEAD`,
        this.opts.repoPath,
      );
      if (result.exitCode !== 0) {
        throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    this.worktreePath = tmpDir;
    this.baseCommit = shaResult.stdout.trim();
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const wt = this.requireWorktree();
    const mapped = cmd.replaceAll(REPO_DIR, wt);
    const cwd = opts.cwd !== undefined ? repoToWt(opts.cwd, wt) : wt;
    return runInDir(mapped, cwd, opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
  }

  async readFile(path: string): Promise<string> {
    const absPath = this.resolvePath(path);
    try {
      return await fsReadFile(absPath, "utf8");
    } catch (err: unknown) {
      throw new Error(`Cannot read ${path}: ${(err as NodeJS.ErrnoException).message}`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const absPath = this.resolvePath(path);
    await mkdir(dirname(absPath), { recursive: true });
    await fsWriteFile(absPath, content, "utf8");
  }

  async diff(): Promise<string> {
    const wt = this.requireWorktree();
    const base = this.baseCommit!;
    const result = await runInDir(`git add -A && git diff --cached --binary ${base}`, wt);
    if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async setNetwork(_enabled: boolean): Promise<void> {
    // no-op: cannot control network access on the host
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const wt = this.worktreePath;
    if (wt !== undefined) {
      this.worktreePath = undefined;
      const result = await runInDir(`git worktree remove --force ${sq(wt)}`, this.opts.repoPath);
      if (result.exitCode !== 0) {
        // Fallback: rm the directory directly if git worktree remove failed.
        await rm(wt, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private requireWorktree(): string {
    if (this.worktreePath === undefined || this.destroyed) {
      throw new Error("Sandbox is not running");
    }
    return this.worktreePath;
  }

  private resolvePath(path: string): string {
    const wt = this.requireWorktree();
    const abs = resolve(repoToWt(path, wt));
    if (abs !== wt && !abs.startsWith(`${wt}/`)) {
      throw new Error(`Path "${path}" escapes the sandbox.`);
    }
    return abs;
  }
}

/** Map /repo or /repo/... to the worktree root or its subdirectory. */
function repoToWt(path: string, wt: string): string {
  if (path === REPO_DIR) return wt;
  if (path.startsWith(`${REPO_DIR}/`)) return join(wt, path.slice(REPO_DIR.length + 1));
  return path;
}

/** Shell-quote a path to pass it safely as an argument. */
function sq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

async function runInDir(
  cmd: string,
  cwd: string,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const chunks: { out: boolean; data: Buffer }[] = [];
    let totalOut = 0;
    let totalErr = 0;
    let timedOut = false;

    const proc = spawn("bash", ["-c", cmd], { cwd });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutSec * 1000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (totalOut < MAX_CAPTURE_BYTES) {
        chunks.push({ out: true, data: chunk });
        totalOut += chunk.length;
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (totalErr < MAX_CAPTURE_BYTES) {
        chunks.push({ out: false, data: chunk });
        totalErr += chunk.length;
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.filter((c) => c.out).map((c) => c.data))
        .subarray(0, MAX_CAPTURE_BYTES)
        .toString("utf8");
      const stderr = Buffer.concat(chunks.filter((c) => !c.out).map((c) => c.data))
        .subarray(0, MAX_CAPTURE_BYTES)
        .toString("utf8");
      resolve({ exitCode: timedOut ? 124 : (code ?? -1), stdout, stderr, timedOut });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

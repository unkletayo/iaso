import { posix } from "node:path";
import { Writable } from "node:stream";
import type { Readable } from "node:stream";
import Docker from "dockerode";
import {
  CONTAINER_LABEL,
  DEFAULT_IMAGE,
  REPO_DIR,
  SANDBOX_LIMITS,
  SANDBOX_USER,
  containerName,
} from "./images.js";
import { installSignalHandlers, registerForCleanup } from "./cleanup.js";
import { makeTar, tarDirectory } from "./tar.js";
import type { ExecOptions, ExecResult, Sandbox } from "./types.js";

const UID = 1000;
const GID = 1000;
const DEFAULT_TIMEOUT_SEC = 120;
/** Cap per stream so a runaway command cannot exhaust host memory. Tools trim further. */
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const BASELINE_TAG = "iaso-baseline";

export interface ContainerSpec {
  name: string;
  image: string;
  runId: string;
}

export interface RawExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The slice of Docker that `DockerSandbox` needs. Tests fake it; `dockerodeApi` implements it. */
export interface DockerApi {
  ensureImage: (image: string) => Promise<void>;
  createContainer: (spec: ContainerSpec) => Promise<string>;
  startContainer: (id: string) => Promise<void>;
  /** Extract a tar stream into `destDir` (which must exist). */
  putTar: (id: string, tar: Readable | Buffer, destDir: string) => Promise<void>;
  exec: (id: string, argv: string[], cwd: string) => Promise<RawExecResult>;
  setNetwork: (id: string, enabled: boolean) => Promise<void>;
  /** Force-remove. A container that is already gone is not an error. */
  removeContainer: (id: string) => Promise<void>;
}

export interface DockerSandboxOptions {
  runId: string;
  image?: string;
  /** Host repo to copy into /repo. Omit when the image already contains /repo. */
  repoPath?: string;
  api?: DockerApi;
  /** Tests turn this off so they do not hook the real process. */
  handleSignals?: boolean;
}

let signalsInstalled = false;

export class DockerSandbox implements Sandbox {
  private readonly api: DockerApi;
  private readonly name: string;
  private readonly image: string;
  private containerId: string | undefined;
  private unregister: (() => void) | undefined;
  private destroyed = false;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.api = opts.api ?? dockerodeApi();
    this.name = containerName(opts.runId);
    this.image = opts.image ?? DEFAULT_IMAGE;
  }

  async start(): Promise<void> {
    if (this.containerId !== undefined) throw new Error("Sandbox already started");
    if (this.opts.handleSignals !== false && !signalsInstalled) {
      signalsInstalled = true;
      installSignalHandlers();
    }
    this.unregister = registerForCleanup(this);
    try {
      await this.api.ensureImage(this.image);
      this.containerId = await this.api.createContainer({
        name: this.name,
        image: this.image,
        runId: this.opts.runId,
      });
      await this.api.startContainer(this.containerId);
      await this.ensureRepoDir();
      if (this.opts.repoPath !== undefined) await this.copyRepoIn(this.opts.repoPath);
      await this.recordBaseline();
    } catch (err) {
      await this.destroy().catch(() => undefined);
      throw err;
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const id = this.requireId();
    const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const started = Date.now();
    const raw = await this.api.exec(
      id,
      ["timeout", "-k", "5", String(timeoutSec), "bash", "-c", cmd],
      opts.cwd ?? REPO_DIR,
    );
    const elapsedMs = Date.now() - started;
    // `timeout` exits 124 on timeout, or 137 if it had to SIGKILL the command.
    // 137 alone can also mean out-of-memory, so require that the time limit was actually reached.
    const timedOut =
      raw.exitCode === 124 || (raw.exitCode === 137 && elapsedMs >= timeoutSec * 1000 - 500);
    return { ...raw, timedOut };
  }

  async readFile(path: string): Promise<string> {
    const res = await this.api.exec(this.requireId(), ["cat", "--", path], REPO_DIR);
    if (res.exitCode !== 0) {
      throw new Error(
        `Cannot read ${path}: ${res.stderr.trim() || `exit ${String(res.exitCode)}`}`,
      );
    }
    return res.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const id = this.requireId();
    const dir = posix.dirname(path);
    const mkdir = await this.api.exec(id, ["mkdir", "-p", "--", dir], REPO_DIR);
    if (mkdir.exitCode !== 0) throw new Error(`Cannot create ${dir}: ${mkdir.stderr.trim()}`);

    // Keep the mode of an existing file (e.g. an executable script); new files get 0644.
    const stat = await this.api.exec(id, ["stat", "-c", "%a", "--", path], REPO_DIR);
    const mode = stat.exitCode === 0 ? Number.parseInt(stat.stdout.trim(), 8) : 0o644;

    await this.api.putTar(
      id,
      makeTar([
        {
          name: posix.basename(path),
          content: Buffer.from(content, "utf8"),
          mode,
          uid: UID,
          gid: GID,
        },
      ]),
      dir,
    );
  }

  async diff(): Promise<string> {
    const res = await this.api.exec(
      this.requireId(),
      ["bash", "-c", `git add -A && git diff --cached --binary ${BASELINE_TAG}`],
      REPO_DIR,
    );
    if (res.exitCode !== 0) throw new Error(`git diff failed: ${res.stderr.trim()}`);
    return res.stdout;
  }

  async setNetwork(enabled: boolean): Promise<void> {
    await this.api.setNetwork(this.requireId(), enabled);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.unregister?.();
    if (this.containerId !== undefined) await this.api.removeContainer(this.containerId);
    // Only after a successful removal, so a failed destroy can be retried.
    this.destroyed = true;
  }

  private requireId(): string {
    if (this.containerId === undefined || this.destroyed) {
      throw new Error("Sandbox is not running");
    }
    return this.containerId;
  }

  /** Make sure /repo exists and belongs to the sandbox user (plain images do not have it). */
  private async ensureRepoDir(): Promise<void> {
    const id = this.requireId();
    const probe = await this.api.exec(id, ["test", "-d", REPO_DIR], "/");
    if (probe.exitCode === 0) return;
    // The daemon extracts archives as root, so this works even though the container user has no
    // capabilities (a plain `mkdir /repo` as uid 1000 would be denied).
    await this.api.putTar(
      id,
      makeTar([{ name: `${REPO_DIR.slice(1)}/`, mode: 0o755, uid: UID, gid: GID }]),
      "/",
    );
  }

  private async copyRepoIn(repoPath: string): Promise<void> {
    const { stream, done } = tarDirectory(repoPath, UID, GID);
    await this.api.putTar(this.requireId(), stream, REPO_DIR);
    await done;
  }

  /** Commit the starting state so `diff()` shows only what the agent changed. */
  private async recordBaseline(): Promise<void> {
    const script = [
      "set -e",
      "git rev-parse --git-dir >/dev/null 2>&1 || git init -q",
      "git add -A",
      "git -c user.name=iaso -c user.email=iaso@localhost -c core.hooksPath=/dev/null " +
        "commit -q --allow-empty --no-verify -m iaso-baseline",
      `git tag -f ${BASELINE_TAG} >/dev/null`,
    ].join("\n");
    const res = await this.api.exec(this.requireId(), ["bash", "-c", script], REPO_DIR);
    if (res.exitCode !== 0) {
      throw new Error(
        `Cannot record baseline (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
  }
}

class Capture extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  override _write(chunk: Buffer, _enc: BufferEncoding, done: () => void): void {
    if (this.size < MAX_CAPTURE_BYTES) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    done();
  }

  text(): string {
    return Buffer.concat(this.chunks).subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
  }
}

interface Demuxer {
  demuxStream(
    stream: NodeJS.ReadableStream,
    out: NodeJS.WritableStream,
    err: NodeJS.WritableStream,
  ): void;
}

function isStatus(err: unknown, status: number): boolean {
  return (
    typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === status
  );
}

/** Real Docker, through dockerode. Covered by the opt-in integration tests (IASO_DOCKER=1). */
export function dockerodeApi(docker: Docker = new Docker()): DockerApi {
  return {
    async ensureImage(image) {
      try {
        await docker.getImage(image).inspect();
        return;
      } catch (err) {
        if (!isStatus(err, 404)) throw err;
      }
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    async createContainer(spec) {
      const container = await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Cmd: ["sleep", "infinity"],
        User: SANDBOX_USER,
        // No secrets in the environment. HOME must be writable for the non-root user.
        Env: ["HOME=/tmp"],
        Labels: { [CONTAINER_LABEL]: spec.runId },
        HostConfig: {
          NanoCpus: SANDBOX_LIMITS.cpus * 1e9,
          Memory: SANDBOX_LIMITS.memoryBytes,
          MemorySwap: SANDBOX_LIMITS.memoryBytes, // equal to Memory: no swap
          PidsLimit: SANDBOX_LIMITS.pids,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          NetworkMode: "bridge",
        },
      });
      return container.id;
    },

    async startContainer(id) {
      await docker.getContainer(id).start();
    },

    async putTar(id, tar, destDir) {
      await docker.getContainer(id).putArchive(tar, { path: destDir });
    },

    async exec(id, argv, cwd) {
      const exec = await docker.getContainer(id).exec({
        Cmd: argv,
        WorkingDir: cwd,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const out = new Capture();
      const err = new Capture();
      (docker.modem as Demuxer).demuxStream(stream, out, err);
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("close", resolve);
        stream.on("error", reject);
      });
      const info = await exec.inspect();
      return { exitCode: info.ExitCode ?? -1, stdout: out.text(), stderr: err.text() };
    },

    async setNetwork(id, enabled) {
      const network = docker.getNetwork("bridge");
      if (enabled) await network.connect({ Container: id });
      else await network.disconnect({ Container: id, Force: true });
    },

    async removeContainer(id) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true });
      } catch (err) {
        if (!isStatus(err, 404)) throw err;
      }
    },
  };
}

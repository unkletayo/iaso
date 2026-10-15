import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox, dockerodeApi } from "../../src/sandbox/docker.js";
import { DEFAULT_IMAGE, containerName } from "../../src/sandbox/images.js";

/**
 * Real Docker. Opt in with: IASO_DOCKER=1 npx vitest run test/integration
 * The first run pulls the base image (about 1 GB).
 */
const enabled = process.env.IASO_DOCKER === "1";
const docker = new Docker();
const created: DockerSandbox[] = [];

function newRunId(label: string): string {
  return `it-${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 6)}`;
}

async function exists(name: string): Promise<boolean> {
  try {
    await docker.getContainer(name).inspect();
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404) {
      return false;
    }
    throw err;
  }
}

async function track(sandbox: DockerSandbox): Promise<DockerSandbox> {
  created.push(sandbox);
  await sandbox.start();
  return sandbox;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iaso-it-repo-"));
  writeFileSync(join(dir, "a.txt"), "original\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.js"), "x");
  return dir;
}

describe.skipIf(!enabled)("DockerSandbox (real Docker)", () => {
  beforeAll(async () => {
    await dockerodeApi(docker).ensureImage(DEFAULT_IMAGE);
  }, 15 * 60_000);

  afterAll(async () => {
    await Promise.allSettled(created.map((s) => s.destroy()));
  }, 60_000);

  it("runs a command inside as a non-root user in /repo", { timeout: 120_000 }, async () => {
    const sb = await track(new DockerSandbox({ runId: newRunId("exec"), repoPath: makeRepo() }));
    const res = await sb.exec("pwd && id -u && echo err >&2; exit 3");
    expect(res.stdout.split("\n").slice(0, 2)).toEqual(["/repo", "1000"]);
    expect(res.stderr).toBe("err\n");
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  it("applies the spec limits and hardening", { timeout: 120_000 }, async () => {
    const runId = newRunId("limits");
    await track(new DockerSandbox({ runId }));
    const info = await docker.getContainer(containerName(runId)).inspect();
    expect(info.HostConfig.NanoCpus).toBe(2e9);
    expect(info.HostConfig.Memory).toBe(4 * 1024 ** 3);
    expect(info.HostConfig.PidsLimit).toBe(1024);
    expect(info.Config.User).toBe("1000:1000");
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(info.Mounts).toEqual([]);
    expect(info.Config.Labels["iaso.run"]).toBe(runId);
    expect(info.Config.Env.filter((e) => /KEY|TOKEN|SECRET|PASSWORD/i.test(e))).toEqual([]);
  });

  it(
    "copies the repo in, skips node_modules, and diffs only agent changes",
    {
      timeout: 120_000,
    },
    async () => {
      const sb = await track(new DockerSandbox({ runId: newRunId("diff"), repoPath: makeRepo() }));
      expect(await sb.readFile("/repo/a.txt")).toBe("original\n");
      expect((await sb.exec("test -e node_modules")).exitCode).not.toBe(0);
      expect(await sb.diff()).toBe("");

      await sb.writeFile("/repo/a.txt", "changed\n");
      await sb.writeFile("/repo/src/new.ts", "export {};\n");
      await sb.writeFile("/repo/run.sh", "#!/bin/sh\necho changed\n");

      const diff = await sb.diff();
      expect(diff).toContain("-original");
      expect(diff).toContain("+changed");
      expect(diff).toContain("b/src/new.ts");
      expect((await sb.exec("test -x run.sh")).exitCode).toBe(0); // mode preserved
      expect((await sb.exec("stat -c %u:%g a.txt src/new.ts")).stdout).toBe(
        "1000:1000\n1000:1000\n",
      );
    },
  );

  it("cuts and restores the network", { timeout: 120_000 }, async () => {
    const runId = newRunId("net");
    const sb = await track(new DockerSandbox({ runId }));
    const networks = async (): Promise<string[]> =>
      Object.keys(
        (await docker.getContainer(containerName(runId)).inspect()).NetworkSettings.Networks,
      );

    expect(await networks()).toEqual(["bridge"]);
    await sb.setNetwork(false);
    expect(await networks()).toEqual([]);
    // The bridge interface is gone (only lo and kernel tunnel stubs remain), and a real
    // connection attempt fails. 1.1.1.1:53 is only a probe target; nothing is sent to it.
    expect((await sb.exec("ls /sys/class/net")).stdout).not.toMatch(/\beth\d/);
    const probe = "exec 3<>/dev/tcp/1.1.1.1/53";
    expect((await sb.exec(probe, { timeoutSec: 10 })).exitCode).not.toBe(0);
    await sb.setNetwork(true);
    expect(await networks()).toEqual(["bridge"]);
    expect((await sb.exec("ls /sys/class/net")).stdout).toMatch(/\beth\d/);
  });

  it("kills a command that exceeds its timeout", { timeout: 120_000 }, async () => {
    const sb = await track(new DockerSandbox({ runId: newRunId("timeout") }));
    const started = Date.now();
    const res = await sb.exec("sleep 60", { timeoutSec: 2 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("removes the container on destroy", { timeout: 120_000 }, async () => {
    const runId = newRunId("destroy");
    const sb = await track(new DockerSandbox({ runId }));
    expect(await exists(containerName(runId))).toBe(true);
    await sb.destroy();
    expect(await exists(containerName(runId))).toBe(false);
    await sb.destroy(); // idempotent
  });

  describe("crash safety", () => {
    interface ChildResult {
      name: string;
      code: number | null;
    }

    /** Start crash-child.ts, wait for READY, optionally signal it, and wait for exit. */
    function runChild(
      runId: string,
      mode: "throw" | "wait",
      signal?: NodeJS.Signals,
    ): Promise<ChildResult> {
      return new Promise((resolve, reject) => {
        // Run node directly (not the `tsx` wrapper) so the signal reaches the process that owns
        // the handlers; a wrapper would exit before the child finished cleaning up.
        const child = spawn(
          process.execPath,
          ["--import", "tsx", join(process.cwd(), "test/integration/crash-child.ts"), runId, mode],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let name = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          const match = /READY (\S+)/.exec(out);
          if (match?.[1] !== undefined && name === "") {
            name = match[1];
            if (signal) child.kill(signal);
          }
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ name, code });
        });
      });
    }

    it(
      "removes the container when the process crashes (try/finally)",
      {
        timeout: 180_000,
      },
      async () => {
        const runId = newRunId("crash");
        const { name, code } = await runChild(runId, "throw");
        expect(name).toBe(containerName(runId));
        expect(code).not.toBe(0);
        expect(await exists(name)).toBe(false);
      },
    );

    it("removes the container on SIGTERM (signal handler)", { timeout: 180_000 }, async () => {
      const runId = newRunId("sigterm");
      const { name, code } = await runChild(runId, "wait", "SIGTERM");
      expect(name).toBe(containerName(runId));
      expect(code).toBe(143);
      expect(await exists(name)).toBe(false);
    });

    it("removes the container on SIGINT (signal handler)", { timeout: 180_000 }, async () => {
      const runId = newRunId("sigint");
      const { name, code } = await runChild(runId, "wait", "SIGINT");
      expect(code).toBe(130);
      expect(await exists(name)).toBe(false);
    });
  });
});

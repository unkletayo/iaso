import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupAll } from "../src/sandbox/cleanup.js";
import { type DockerApi, DockerSandbox, type RawExecResult } from "../src/sandbox/docker.js";

const ok = (stdout = ""): RawExecResult => ({ exitCode: 0, stdout, stderr: "" });

interface FakeOptions {
  exec?: (argv: string[], cwd: string) => RawExecResult | Promise<RawExecResult>;
  createFails?: boolean;
}

function fakeApi(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const putTars: { dest: string; bytes: number }[] = [];
  const api: DockerApi = {
    ensureImage: vi.fn<DockerApi["ensureImage"]>((image) => {
      calls.push(`ensureImage ${image}`);
      return Promise.resolve();
    }),
    createContainer: vi.fn<DockerApi["createContainer"]>((spec) => {
      calls.push(`create ${spec.name}`);
      return opts.createFails ? Promise.reject(new Error("create failed")) : Promise.resolve("cid");
    }),
    startContainer: vi.fn<DockerApi["startContainer"]>((id) => {
      calls.push(`start ${id}`);
      return Promise.resolve();
    }),
    putTar: vi.fn<DockerApi["putTar"]>(async (_id, tar, dest) => {
      let bytes = 0;
      if (Buffer.isBuffer(tar)) bytes = tar.length;
      else for await (const chunk of tar) bytes += (chunk as Buffer).length;
      putTars.push({ dest, bytes });
      calls.push(`putTar ${dest}`);
    }),
    exec: vi.fn<DockerApi["exec"]>(async (_id, argv, cwd) => {
      calls.push(`exec ${argv.join(" ")}`);
      return opts.exec ? opts.exec(argv, cwd) : ok();
    }),
    setNetwork: vi.fn<DockerApi["setNetwork"]>((_id, enabled) => {
      calls.push(`network ${String(enabled)}`);
      return Promise.resolve();
    }),
    removeContainer: vi.fn<DockerApi["removeContainer"]>((id) => {
      calls.push(`remove ${id}`);
      return Promise.resolve();
    }),
  };
  return { api, calls, putTars };
}

function sandbox(api: DockerApi, extra: { repoPath?: string } = {}) {
  return new DockerSandbox({ runId: "r1", api, handleSignals: false, ...extra });
}

describe("DockerSandbox.start", () => {
  it("pulls the image, creates and starts iaso-<runId>, records a baseline", async () => {
    const { api, calls } = fakeApi();
    await sandbox(api).start();
    expect(calls[0]).toBe("ensureImage node:22-bookworm");
    expect(calls[1]).toBe("create iaso-r1");
    expect(calls[2]).toBe("start cid");
    expect(calls[3]).toBe("exec test -d /repo");
    expect(calls[4]).toMatch(/^exec bash -c .*git tag -f iaso-baseline/s);
  });

  it("creates /repo as the sandbox user when the image does not have it", async () => {
    const { api, putTars } = fakeApi({
      exec: (argv) => (argv[0] === "test" ? { exitCode: 1, stdout: "", stderr: "" } : ok()),
    });
    await sandbox(api).start();
    expect(putTars.map((p) => p.dest)).toEqual(["/"]);
  });

  it("leaves an existing /repo alone", async () => {
    const { api, putTars } = fakeApi();
    await sandbox(api).start();
    expect(putTars).toEqual([]);
  });

  it("copies the host repo into /repo before the baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iaso-repo-"));
    writeFileSync(join(dir, "a.txt"), "A");
    const { api, calls, putTars } = fakeApi();
    await sandbox(api, { repoPath: dir }).start();
    expect(putTars.map((p) => p.dest)).toEqual(["/repo"]);
    expect(putTars[0]?.bytes).toBeGreaterThan(0);
    const putIdx = calls.indexOf("putTar /repo");
    const baselineIdx = calls.findIndex((c) => c.includes("iaso-baseline"));
    expect(putIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeGreaterThan(putIdx);
  });

  it("removes the container and rethrows when start fails partway", async () => {
    const { api, calls } = fakeApi({ exec: () => ({ exitCode: 1, stdout: "", stderr: "no git" }) });
    await expect(sandbox(api).start()).rejects.toThrow(/Cannot record baseline \(exit 1\): no git/);
    expect(calls).toContain("remove cid");
  });

  it("is safe to destroy when create itself failed", async () => {
    const { api, calls } = fakeApi({ createFails: true });
    await expect(sandbox(api).start()).rejects.toThrow("create failed");
    expect(calls.some((c) => c.startsWith("remove"))).toBe(false);
  });

  it("rejects a second start", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    await expect(sb.start()).rejects.toThrow(/already started/);
  });
});

describe("DockerSandbox.exec", () => {
  it("wraps the command in timeout/bash and defaults to /repo and 120s", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    await sb.exec("echo hi");
    expect(api.exec).toHaveBeenLastCalledWith(
      "cid",
      ["timeout", "-k", "5", "120", "bash", "-c", "echo hi"],
      "/repo",
    );
  });

  it("honours timeoutSec and cwd", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    await sb.exec("ls", { timeoutSec: 7, cwd: "/tmp" });
    expect(api.exec).toHaveBeenLastCalledWith(
      "cid",
      ["timeout", "-k", "5", "7", "bash", "-c", "ls"],
      "/tmp",
    );
  });

  it("returns exit code and output, timedOut false on a normal failure", async () => {
    const { api } = fakeApi({
      exec: (argv) => (argv[0] === "timeout" ? { exitCode: 3, stdout: "o", stderr: "e" } : ok()),
    });
    const sb = sandbox(api);
    await sb.start();
    expect(await sb.exec("false")).toEqual({
      exitCode: 3,
      stdout: "o",
      stderr: "e",
      timedOut: false,
    });
  });

  it("flags exit 124 as a timeout", async () => {
    const { api } = fakeApi({
      exec: (argv) => (argv[0] === "timeout" ? { exitCode: 124, stdout: "", stderr: "" } : ok()),
    });
    const sb = sandbox(api);
    await sb.start();
    expect((await sb.exec("sleep 99", { timeoutSec: 1 })).timedOut).toBe(true);
  });

  it("does not call a fast exit 137 (e.g. out of memory) a timeout", async () => {
    const { api } = fakeApi({
      exec: (argv) => (argv[0] === "timeout" ? { exitCode: 137, stdout: "", stderr: "" } : ok()),
    });
    const sb = sandbox(api);
    await sb.start();
    expect((await sb.exec("hog", { timeoutSec: 60 })).timedOut).toBe(false);
  });

  it("throws before start and after destroy", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await expect(sb.exec("x")).rejects.toThrow(/not running/);
    await sb.start();
    await sb.destroy();
    await expect(sb.exec("x")).rejects.toThrow(/not running/);
  });
});

describe("DockerSandbox files and diff", () => {
  it("reads a file with cat, and throws with stderr when it fails", async () => {
    const { api } = fakeApi({
      exec: (argv) => {
        if (argv[0] === "cat" && argv[2] === "/repo/a.txt") return ok("content");
        if (argv[0] === "cat") return { exitCode: 1, stdout: "", stderr: "No such file" };
        return ok();
      },
    });
    const sb = sandbox(api);
    await sb.start();
    expect(await sb.readFile("/repo/a.txt")).toBe("content");
    await expect(sb.readFile("/repo/nope")).rejects.toThrow(/No such file/);
  });

  it("writes a file via mkdir + tar into its directory", async () => {
    const { api, putTars, calls } = fakeApi({
      exec: (argv) => (argv[0] === "stat" ? { exitCode: 1, stdout: "", stderr: "" } : ok()),
    });
    const sb = sandbox(api);
    await sb.start();
    await sb.writeFile("/repo/src/new.ts", "export {};\n");
    expect(calls).toContain("exec mkdir -p -- /repo/src");
    expect(putTars.at(-1)?.dest).toBe("/repo/src");
  });

  it("preserves the mode of an existing file", async () => {
    const { api } = fakeApi({
      exec: (argv) => (argv[0] === "stat" ? ok("755\n") : ok()),
    });
    const sb = sandbox(api);
    await sb.start();
    await sb.writeFile("/repo/run.sh", "#!/bin/sh\n");
    const tar = vi.mocked(api.putTar).mock.calls.at(-1)?.[1];
    expect(Buffer.isBuffer(tar)).toBe(true);
    // ustar mode field: "0000755\0" at offset 100
    expect((tar as Buffer).subarray(100, 107).toString()).toBe("0000755");
  });

  it("returns the staged diff against the baseline", async () => {
    const { api } = fakeApi({
      exec: (argv) =>
        argv[2]?.includes("git diff --cached --binary iaso-baseline")
          ? ok("diff --git a/x b/x\n")
          : ok(),
    });
    const sb = sandbox(api);
    await sb.start();
    expect(await sb.diff()).toBe("diff --git a/x b/x\n");
  });

  it("throws when git diff fails", async () => {
    const { api } = fakeApi({
      exec: (argv) =>
        argv[2]?.includes("git diff") ? { exitCode: 128, stdout: "", stderr: "fatal" } : ok(),
    });
    const sb = sandbox(api);
    await sb.start();
    await expect(sb.diff()).rejects.toThrow(/git diff failed: fatal/);
  });
});

describe("DockerSandbox network and destroy", () => {
  it("switches the network", async () => {
    const { api, calls } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    await sb.setNetwork(false);
    await sb.setNetwork(true);
    expect(calls).toContain("network false");
    expect(calls).toContain("network true");
  });

  it("destroy is idempotent", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    await sb.destroy();
    await sb.destroy();
    expect(api.removeContainer).toHaveBeenCalledTimes(1);
  });

  it("can retry destroy after a failed removal", async () => {
    const { api } = fakeApi();
    vi.mocked(api.removeContainer).mockRejectedValueOnce(new Error("busy"));
    const sb = sandbox(api);
    await sb.start();
    await expect(sb.destroy()).rejects.toThrow("busy");
    await sb.destroy();
    expect(api.removeContainer).toHaveBeenCalledTimes(2);
  });

  it("is torn down by the cleanup registry (signal path)", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    expect(await cleanupAll()).toEqual([]);
    expect(api.removeContainer).toHaveBeenCalledWith("cid");
  });

  it("does not leave a registered sandbox behind after destroy", async () => {
    const { api } = fakeApi();
    const sb = sandbox(api);
    await sb.start();
    await sb.destroy();
    await cleanupAll();
    expect(api.removeContainer).toHaveBeenCalledTimes(1);
  });
});

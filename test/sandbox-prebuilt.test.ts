import { describe, expect, it, vi } from "vitest";
import {
  type ContainerSpec,
  type DockerApi,
  DockerSandbox,
  type RawExecResult,
} from "../src/sandbox/docker.js";
import { SWEBENCH_REPO, instanceImage, setupScript } from "../src/sandbox/prebuilt.js";

const ok = (stdout = ""): RawExecResult => ({ exitCode: 0, stdout, stderr: "" });

interface Exec {
  argv: string[];
  cwd: string;
  user: string | undefined;
}

function fakeApi(over: { exec?: (e: Exec) => RawExecResult } = {}) {
  const specs: ContainerSpec[] = [];
  const execs: Exec[] = [];
  const removed: string[] = [];
  const tars: string[] = [];
  const api: DockerApi = {
    ensureImage: vi.fn<DockerApi["ensureImage"]>(() => Promise.resolve()),
    createContainer: vi.fn<DockerApi["createContainer"]>((spec) => {
      specs.push(spec);
      return Promise.resolve("cid");
    }),
    startContainer: vi.fn<DockerApi["startContainer"]>(() => Promise.resolve()),
    putTar: vi.fn<DockerApi["putTar"]>((_id, _tar, dest) => {
      tars.push(dest);
      return Promise.resolve();
    }),
    exec: vi.fn<DockerApi["exec"]>((_id, argv, cwd, user) => {
      const e = { argv, cwd, user };
      execs.push(e);
      return Promise.resolve(over.exec ? over.exec(e) : ok());
    }),
    setNetwork: vi.fn<DockerApi["setNetwork"]>(() => Promise.resolve()),
    removeContainer: vi.fn<DockerApi["removeContainer"]>((id) => {
      removed.push(id);
      return Promise.resolve();
    }),
  };
  return { api, specs, execs, removed, tars };
}

describe("instanceImage", () => {
  it("names the official per-instance image", () => {
    expect(instanceImage("psf__requests-3362")).toBe(
      "swebench/sweb.eval.x86_64.psf_1776_requests-3362:latest",
    );
    expect(instanceImage("scikit-learn__scikit-learn-13779")).toBe(
      "swebench/sweb.eval.x86_64.scikit-learn_1776_scikit-learn-13779:latest",
    );
  });

  it("lower-cases, as Docker requires", () => {
    expect(instanceImage("Owner__Repo-1")).toBe(
      "swebench/sweb.eval.x86_64.owner_1776_repo-1:latest",
    );
  });
});

describe("setupScript", () => {
  const lines = setupScript("/testbed").split("\n");
  const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));

  it("stops on the first error", () => {
    expect(lines[0]).toBe("set -e");
  });

  it("links /repo, cuts the history back to HEAD, then hands the repo over, in that order", () => {
    const link = at("ln -sfn '/testbed' /repo");
    const detach = at("git checkout -q --detach");
    const refs = at("git update-ref -d");
    const expire = at("git reflog expire");
    const chown = at("chown -R 1000:1000 '/testbed'");
    for (const i of [link, detach, refs, expire, chown]) expect(i).toBeGreaterThan(0);
    expect(link).toBeLessThan(detach);
    expect(detach).toBeLessThan(refs);
    expect(refs).toBeLessThan(expire);
    expect(expire).toBeLessThan(chown);
  });

  it("looks for future commits before it deletes the refs that reach them", () => {
    expect(at("future=$(git rev-list --all --not")).toBeLessThan(at("git update-ref -d"));
    expect(setupScript("/testbed")).toContain(
      'if [ -n "$future" ]; then git gc -q --prune=now; fi',
    );
  });

  it("refuses an image that already has a real /repo", () => {
    expect(setupScript("/testbed")).toContain("[ -e /repo ] && [ ! -L /repo ]");
  });

  it("quotes the directory", () => {
    expect(setupScript("/my dir's/repo")).toContain(`cd '/my dir'\\''s/repo'`);
  });
});

describe("DockerSandbox with a prebuilt repo", () => {
  const make = (api: DockerApi) =>
    new DockerSandbox({ runId: "r1", api, handleSignals: false, prebuilt: SWEBENCH_REPO });

  it("keeps one capability and the repo's environment, and drops nothing else", async () => {
    const { api, specs } = fakeApi();
    await make(api).start();
    expect(specs[0]?.capAdd).toEqual(["CHOWN"]);
    expect(specs[0]?.env).toEqual(SWEBENCH_REPO.env);
  });

  it("runs the setup as root from /, once, before the baseline", async () => {
    const { api, execs, tars } = fakeApi();
    await make(api).start();
    const rootRuns = execs.filter((e) => e.user !== undefined);
    expect(rootRuns).toHaveLength(1);
    expect(rootRuns[0]).toMatchObject({ user: "0", cwd: "/" });
    expect(rootRuns[0]?.argv[2]).toBe(setupScript("/testbed"));
    const setup = execs.indexOf(rootRuns[0] as Exec);
    const baseline = execs.findIndex((e) => e.argv.join(" ").includes("iaso-baseline"));
    expect(setup).toBeLessThan(baseline);
    // No /repo directory is created or filled: /repo is the link made by the setup.
    expect(tars).toEqual([]);
    expect(execs.some((e) => e.argv[0] === "test")).toBe(false);
  });

  it("runs the baseline as the sandbox user, not as root", async () => {
    const { api, execs } = fakeApi();
    await make(api).start();
    const baseline = execs.find((e) => e.argv.join(" ").includes("iaso-baseline"));
    expect(baseline?.user).toBeUndefined();
  });

  it("removes the container and reports the error when the setup fails", async () => {
    const { api, removed } = fakeApi({
      exec: (e) => (e.user === "0" ? { exitCode: 1, stdout: "", stderr: "chown: denied" } : ok()),
    });
    await expect(make(api).start()).rejects.toThrow(/Cannot set up \/testbed.*chown: denied/s);
    expect(removed).toEqual(["cid"]);
  });

  it("refuses a host repo and a prebuilt repo together", () => {
    const { api } = fakeApi();
    expect(
      () =>
        new DockerSandbox({
          runId: "r1",
          api,
          repoPath: "/tmp/x",
          prebuilt: SWEBENCH_REPO,
          handleSignals: false,
        }),
    ).toThrow(/not both/);
  });
});

describe("DockerSandbox without a prebuilt repo", () => {
  it("gets no extra capability, no extra environment and no root command", async () => {
    const { api, specs, execs } = fakeApi();
    await new DockerSandbox({ runId: "r1", api, handleSignals: false }).start();
    expect(specs[0]?.capAdd).toBeUndefined();
    expect(specs[0]?.env).toBeUndefined();
    expect(execs.every((e) => e.user === undefined)).toBe(true);
  });
});

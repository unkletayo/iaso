import { describe, expect, it, vi } from "vitest";
import type { ExecOptions, ExecResult, Sandbox } from "../src/sandbox/types.js";
import { bashTool, formatExecResult } from "../src/tools/bash.js";
import { runTool } from "../src/tools/schema.js";

const unused = (): Promise<never> => Promise.reject(new Error("not used in this test"));

function sandboxReturning(result: Partial<ExecResult>) {
  const exec = vi.fn<(cmd: string, opts?: ExecOptions) => Promise<ExecResult>>().mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...result,
  });
  const sandbox: Sandbox = {
    start: unused,
    exec,
    readFile: unused,
    writeFile: unused,
    diff: unused,
    setNetwork: unused,
    destroy: unused,
  };
  return { sandbox, exec };
}

describe("bash tool", () => {
  it("runs the command and reports exit code and stdout", async () => {
    const { sandbox, exec } = sandboxReturning({ stdout: "hello\n" });
    const res = await runTool(bashTool, { cmd: "echo hello" }, { sandbox, step: 1 });
    expect(res).toEqual({ output: "exit code: 0\n--- stdout ---\nhello", isError: false });
    expect(exec).toHaveBeenCalledWith("echo hello", {});
  });

  it("forwards timeoutSec to the sandbox", async () => {
    const { sandbox, exec } = sandboxReturning({});
    await runTool(bashTool, { cmd: "sleep 1", timeoutSec: 30 }, { sandbox, step: 1 });
    expect(exec).toHaveBeenCalledWith("sleep 1", { timeoutSec: 30 });
  });

  it("shows both streams and does not treat a non-zero exit as a tool error", async () => {
    const { sandbox } = sandboxReturning({ exitCode: 1, stdout: "out\n", stderr: "boom\n" });
    const res = await runTool(bashTool, { cmd: "make" }, { sandbox, step: 1 });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("exit code: 1\n--- stdout ---\nout\n--- stderr ---\nboom");
  });

  it("flags a timeout as an error and says the command was killed", async () => {
    const { sandbox } = sandboxReturning({ exitCode: 124, timedOut: true });
    const res = await runTool(bashTool, { cmd: "sleep 99", timeoutSec: 5 }, { sandbox, step: 1 });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("TIMED OUT after 5s");
  });

  it("says so when there is no output", async () => {
    const { sandbox } = sandboxReturning({});
    const res = await runTool(bashTool, { cmd: "true" }, { sandbox, step: 1 });
    expect(res.output).toBe("exit code: 0\n(no output)");
  });

  it("keeps the end of stderr when output is very long", async () => {
    const { sandbox } = sandboxReturning({
      exitCode: 2,
      stdout: "x".repeat(30_000),
      stderr: "FINAL ERROR LINE\n",
    });
    const res = await runTool(bashTool, { cmd: "build" }, { sandbox, step: 1 });
    expect(res.output).toContain("characters cut");
    expect(res.output.endsWith("FINAL ERROR LINE")).toBe(true);
  });

  it("rejects an empty command and out-of-range timeouts without calling the sandbox", async () => {
    const { sandbox, exec } = sandboxReturning({});
    for (const bad of [
      { cmd: "" },
      { cmd: "x", timeoutSec: 0 },
      { cmd: "x", timeoutSec: 601 },
      {},
    ]) {
      const res = await runTool(bashTool, bad, { sandbox, step: 1 });
      expect(res.isError).toBe(true);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns an error result when the sandbox itself fails", async () => {
    const { sandbox, exec } = sandboxReturning({});
    exec.mockRejectedValue(new Error("Sandbox is not running"));
    const res = await runTool(bashTool, { cmd: "ls" }, { sandbox, step: 1 });
    expect(res).toEqual({ output: "bash failed: Sandbox is not running", isError: true });
  });
});

describe("formatExecResult", () => {
  it("names the time limit generically when none was given", () => {
    const out = formatExecResult(
      { exitCode: 124, stdout: "", stderr: "", timedOut: true },
      undefined,
    );
    expect(out).toContain("TIMED OUT after the time limit");
  });
});

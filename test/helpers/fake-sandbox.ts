import { vi } from "vitest";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types.js";

export function fakeSandbox(
  files: Record<string, string> = {},
  onExec?: (cmd: string, o?: ExecOptions) => ExecResult,
) {
  const store = new Map(Object.entries(files));
  // Kept as a separate variable so tests can assert on it without reading a method off `sandbox`.
  const exec = vi.fn((cmd: string, o?: ExecOptions) =>
    Promise.resolve(onExec?.(cmd, o) ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false }),
  );
  const sandbox: Sandbox = {
    start: () => Promise.resolve(),
    exec,
    readFile: (p) => {
      const c = store.get(p);
      return c === undefined ? Promise.reject(new Error(`ENOENT ${p}`)) : Promise.resolve(c);
    },
    writeFile: (p, c) => {
      store.set(p, c);
      return Promise.resolve();
    },
    diff: () => Promise.resolve("DIFF"),
    setNetwork: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return { sandbox, exec, files: store };
}

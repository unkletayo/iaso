import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickReproCommand, testFilesOf, verifyRun } from "../src/agent/verify.js";
import type { ExecResult, Sandbox } from "../src/sandbox/types.js";

const run = promisify(execFile);

/** A sandbox that runs commands with real bash and git in a temp folder, like /repo in Docker. */
function hostSandbox(dir: string): Sandbox {
  return {
    start: () => Promise.resolve(),
    async exec(cmd): Promise<ExecResult> {
      try {
        const { stdout, stderr } = await run("bash", ["-c", cmd], { cwd: dir });
        return { exitCode: 0, stdout, stderr, timedOut: false };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          timedOut: false,
        };
      }
    },
    readFile: (p) => readFile(join(dir, p), "utf8"),
    writeFile: (p, c) => writeFile(join(dir, p), c),
    diff: () => Promise.resolve(""),
    setNetwork: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
}

const BUGGY = "module.exports = (a, b) => a - b;\n";
const FIXED = "module.exports = (a, b) => a + b;\n";
const TEST =
  "const add = require('../add.js');\nif (add(2, 3) !== 5) { console.error('add(2, 3) is ' + add(2, 3)); process.exit(1); }\n";
const TEST_CMD = "node test/add.test.js";

let dir: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

/** The repo as the sandbox starts it: committed and tagged `iaso-baseline`. */
async function baseline(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) await put(path, content);
  const git = "git -c user.name=t -c user.email=t@t";
  await run(
    "bash",
    ["-c", `git init -q && git add -A && ${git} commit -qm base && git tag iaso-baseline`],
    {
      cwd: dir,
    },
  );
}

const passed = [{ cmd: TEST_CMD, result: "pass" as const, step: 9 }];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iaso-verify-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyRun: the reproduction check", () => {
  it("is verified when the new test fails on the original code and passes with the fix", async () => {
    await baseline({ "add.js": BUGGY, "old.js": "gone\n" });
    await put("add.js", FIXED);
    await put("test/add.test.js", TEST);
    await put("new.js", "added\n");
    await rm(join(dir, "old.js"));

    const v = await verifyRun({
      sandbox: hostSandbox(dir),
      testsRun: passed,
      testsAdded: ["test/add.test.js"],
    });

    expect(v.status).toBe("verified");
    expect(v.reproduction).toMatchObject({ status: "pass", cmd: TEST_CMD });
    expect(v.suite).toEqual({ status: "not_checked", reason: "no testCommand in .iaso.json" });
    // Everything is back as the agent left it: the fix, the new files and the deletion.
    expect(await readFile(join(dir, "add.js"), "utf8")).toBe(FIXED);
    expect(await readFile(join(dir, "new.js"), "utf8")).toBe("added\n");
    expect(await readFile(join(dir, "test/add.test.js"), "utf8")).toBe(TEST);
    await expect(readFile(join(dir, "old.js"), "utf8")).rejects.toThrow();
  });

  it("fails when the test also passes without the fix", async () => {
    await baseline({ "add.js": BUGGY });
    await put("add.js", FIXED);
    await put("test/add.test.js", "process.exit(0);\n");

    const v = await verifyRun({ sandbox: hostSandbox(dir), testsRun: passed, testsAdded: [] });

    expect(v.status).toBe("failed");
    expect(v.reproduction).toMatchObject({
      status: "fail",
      detail: "passes without the fix too, so it does not show the bug",
    });
    expect(await readFile(join(dir, "add.js"), "utf8")).toBe(FIXED);
  });

  it("fails when the test fails with the fix, and keeps the end of its output", async () => {
    await baseline({ "add.js": BUGGY });
    await put("test/add.test.js", TEST);

    const v = await verifyRun({ sandbox: hostSandbox(dir), testsRun: passed, testsAdded: [] });

    expect(v.status).toBe("failed");
    expect(v.reproduction).toMatchObject({ status: "fail", detail: "fails with the fix (exit 1)" });
    expect(v.reproduction.status === "fail" && v.reproduction.tail).toContain("add(2, 3) is -1");
  });

  it("is not checked when the patch has no test file", async () => {
    await baseline({ "add.js": BUGGY });
    await put("add.js", FIXED);

    const v = await verifyRun({ sandbox: hostSandbox(dir), testsRun: passed, testsAdded: [] });

    expect(v.status).toBe("not_checked");
    expect(v.reproduction).toEqual({
      status: "not_checked",
      reason: "the patch adds or changes no test file",
    });
  });

  it("is not checked when the agent noted no passing test command", async () => {
    await baseline({ "add.js": BUGGY });
    await put("add.js", FIXED);
    await put("test/add.test.js", TEST);

    const v = await verifyRun({
      sandbox: hostSandbox(dir),
      testsRun: [{ cmd: TEST_CMD, result: "fail", step: 3 }],
      testsAdded: [],
    });

    expect(v.reproduction).toEqual({
      status: "not_checked",
      reason: "the agent noted no passing test command",
    });
  });
});

describe("verifyRun: the suite check", () => {
  beforeEach(async () => {
    await baseline({ "add.js": BUGGY });
    await put("add.js", FIXED);
    await put("test/add.test.js", TEST);
  });

  it("passes when testCommand passes with the fix", async () => {
    const v = await verifyRun({
      sandbox: hostSandbox(dir),
      testsRun: passed,
      testsAdded: [],
      testCommand: TEST_CMD,
    });
    expect(v.status).toBe("verified");
    expect(v.suite).toMatchObject({ status: "pass", cmd: TEST_CMD });
  });

  it("fails the whole check when testCommand fails", async () => {
    const v = await verifyRun({
      sandbox: hostSandbox(dir),
      testsRun: passed,
      testsAdded: [],
      testCommand: "exit 3",
    });
    expect(v.status).toBe("failed");
    expect(v.reproduction.status).toBe("pass");
    expect(v.suite).toMatchObject({ status: "fail", detail: "fails with the fix (exit 3)" });
  });
});

describe("testFilesOf", () => {
  it("keeps files named in testsAdded and files that look like tests", () => {
    const changed = ["src/add.ts", "src/add.spec.ts", "tests/x.py", "lib/check_me.py", "test_y.py"];
    expect(testFilesOf(changed, ["/repo/lib/check_me.py"])).toEqual([
      "src/add.spec.ts",
      "tests/x.py",
      "lib/check_me.py",
      "test_y.py",
    ]);
  });

  it("does not take source files for tests", () => {
    expect(testFilesOf(["src/contest.ts", "src/latest/index.ts"], [])).toEqual([]);
  });
});

describe("pickReproCommand", () => {
  const runs = [
    { cmd: "pytest tests/test_add.py", result: "pass" as const, step: 4 },
    { cmd: "pytest", result: "pass" as const, step: 8 },
    { cmd: "pytest tests/test_add.py", result: "fail" as const, step: 2 },
  ];

  it("prefers a passing command that names a changed test file", () => {
    expect(pickReproCommand(runs, ["tests/test_add.py"], [])).toBe("pytest tests/test_add.py");
  });

  it("falls back to the latest passing command", () => {
    expect(pickReproCommand(runs, ["tests/other.py"], [])).toBe("pytest");
  });

  it("matches a test name from testsAdded", () => {
    expect(
      pickReproCommand(
        [...runs, { cmd: "pytest -k test_overflow", result: "pass", step: 9 }],
        ["tests/x.py"],
        ["test_overflow"],
      ),
    ).toBe("pytest -k test_overflow");
  });
});

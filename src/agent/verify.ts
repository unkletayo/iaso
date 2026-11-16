import { z } from "zod";
import type { TaskState } from "../context/state.js";
import { BASELINE_TAG } from "../sandbox/docker.js";
import type { ExecResult, Sandbox } from "../sandbox/types.js";
import { shellQuote } from "../tools/edit-file.js";

/**
 * M13 step 13A: after `submit`, Iaso checks the patch itself instead of taking the agent's word.
 * The reproduction check runs the agent's passing test command with the fix (it must pass) and on
 * the original code with only the test files kept (it must fail). The suite check runs the
 * project's `testCommand` with the fix, when `.iaso.json` sets one. Nothing is retried or fixed:
 * the result is only reported.
 */

/** Same ceiling as the `bash` tool: a test command may take that long and no longer. */
export const VERIFY_TIMEOUT_SEC = 600;
/** Lines of output kept with a check, enough to see why a test failed. */
const TAIL_LINES = 20;

export const checkSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["pass", "fail"]),
    cmd: z.string(),
    detail: z.string(),
    /** The last lines of the decisive run's output. */
    tail: z.string(),
  }),
  z.object({ status: z.literal("not_checked"), reason: z.string() }),
]);
export type Check = z.infer<typeof checkSchema>;

export const verificationSchema = z.object({
  status: z.enum(["verified", "failed", "not_checked"]),
  reproduction: checkSchema,
  suite: checkSchema,
});
export type Verification = z.infer<typeof verificationSchema>;

export interface VerifyInput {
  sandbox: Sandbox;
  testsRun: TaskState["testsRun"];
  /** From `submit`: test file paths or test names. */
  testsAdded: readonly string[];
  /** `.iaso.json` `testCommand`. Without it the suite is not checked. */
  testCommand?: string | undefined;
  timeoutSec?: number;
}

const notChecked = (reason: string): Check => ({ status: "not_checked", reason });

/** For a run that never submitted: there is nothing to check. */
export function notVerified(reason: string): Verification {
  return { status: "not_checked", reproduction: notChecked(reason), suite: notChecked(reason) };
}

/** A test file path the way it appears in the repo, without the `/repo/` prefix. */
const repoRelative = (path: string): string =>
  path
    .trim()
    .replace(/^\/repo\//, "")
    .replace(/^\.\//, "");

const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[^/]+$/;

/**
 * Which changed files are tests: those the agent named in `testsAdded`, plus any whose path looks
 * like a test. These are kept when the original code is put back.
 */
export function testFilesOf(changed: readonly string[], testsAdded: readonly string[]): string[] {
  const named = testsAdded.map(repoRelative).filter((t) => t !== "");
  return changed.filter(
    (file) => TEST_PATH.test(file) || named.some((t) => file === t || file.endsWith(`/${t}`)),
  );
}

/**
 * The command that shows the fix works: the latest one the agent noted as passing, preferring one
 * that names a changed test file or a test from `testsAdded`.
 */
export function pickReproCommand(
  testsRun: TaskState["testsRun"],
  testFiles: readonly string[],
  testsAdded: readonly string[],
): string | undefined {
  const passing = testsRun
    .filter((t) => t.result === "pass")
    .map((t) => t.cmd)
    .reverse();
  const names = [
    ...testFiles.map((f) => f.split("/").pop() ?? f).map((f) => f.replace(/\.[^.]+$/, "")),
    ...testsAdded.map(repoRelative).filter((t) => t !== "" && !t.includes("/")),
  ];
  return passing.find((cmd) => names.some((n) => cmd.includes(n))) ?? passing[0];
}

const tailOf = (res: ExecResult): string =>
  `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-TAIL_LINES).join("\n");

const passed = (res: ExecResult): boolean => res.exitCode === 0 && !res.timedOut;

const outcome = (res: ExecResult): string =>
  res.timedOut ? "timed out" : `exit ${String(res.exitCode)}`;

async function git(sandbox: Sandbox, script: string): Promise<ExecResult> {
  return sandbox.exec(script, { timeoutSec: 120 });
}

const gitError = (res: ExecResult): string =>
  res.stderr.trim() || res.stdout.trim() || outcome(res);

async function checkReproduction(
  o: VerifyInput,
  timeoutSec: number,
): Promise<{ check: Check; restored: boolean }> {
  const { sandbox } = o;
  const listed = await git(sandbox, `git add -A && git diff --cached --name-only ${BASELINE_TAG}`);
  if (listed.exitCode !== 0) {
    return {
      check: notChecked(`could not list the changed files: ${gitError(listed)}`),
      restored: true,
    };
  }
  const changed = listed.stdout.split("\n").filter((l) => l !== "");
  const testFiles = testFilesOf(changed, o.testsAdded);
  if (testFiles.length === 0) {
    return { check: notChecked("the patch adds or changes no test file"), restored: true };
  }
  const cmd = pickReproCommand(o.testsRun, testFiles, o.testsAdded);
  if (cmd === undefined) {
    return { check: notChecked("the agent noted no passing test command"), restored: true };
  }

  const withFix = await sandbox.exec(cmd, { timeoutSec });
  if (!passed(withFix)) {
    const check: Check = {
      status: "fail",
      cmd,
      detail: `fails with the fix (${outcome(withFix)})`,
      tail: tailOf(withFix),
    };
    return { check, restored: true };
  }

  const snapshot = await git(sandbox, "git add -A && git write-tree");
  const tree = snapshot.stdout.trim();
  if (snapshot.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    return {
      check: notChecked(`could not save the fixed state: ${gitError(snapshot)}`),
      restored: true,
    };
  }

  let check: Check;
  const original = await git(
    sandbox,
    `git restore --source=${BASELINE_TAG} --staged --worktree -- . && ` +
      `git restore --source=${tree} --staged --worktree -- ${testFiles.map(shellQuote).join(" ")}`,
  );
  if (original.exitCode !== 0) {
    check = notChecked(`could not put the original code back: ${gitError(original)}`);
  } else {
    const withoutFix = await sandbox.exec(cmd, { timeoutSec });
    check = passed(withoutFix)
      ? {
          status: "fail",
          cmd,
          detail: "passes without the fix too, so it does not show the bug",
          tail: tailOf(withoutFix),
        }
      : {
          status: "pass",
          cmd,
          detail: `fails without the fix (${outcome(withoutFix)}) and passes with it`,
          tail: tailOf(withoutFix),
        };
  }

  const back = await git(
    sandbox,
    `git restore --source=${tree} --staged --worktree -- . && git add -A && ` +
      `test "$(git write-tree)" = ${tree}`,
  );
  if (back.exitCode !== 0) {
    return {
      check: notChecked(`could not put the fix back after the check: ${gitError(back)}`),
      restored: false,
    };
  }
  return { check, restored: true };
}

async function checkSuite(o: VerifyInput, timeoutSec: number, restored: boolean): Promise<Check> {
  if (o.testCommand === undefined) return notChecked("no testCommand in .iaso.json");
  if (!restored) return notChecked("the fix could not be put back after the reproduction check");
  const res = await o.sandbox.exec(o.testCommand, { timeoutSec });
  return {
    status: passed(res) ? "pass" : "fail",
    cmd: o.testCommand,
    detail: passed(res) ? "passes with the fix" : `fails with the fix (${outcome(res)})`,
    tail: tailOf(res),
  };
}

/**
 * Run both checks against a sandbox that holds the agent's final state. Call it after the diff has
 * been read: the check moves files around and puts them back, and a failure to put them back is
 * reported, not thrown.
 */
export async function verifyRun(o: VerifyInput): Promise<Verification> {
  const timeoutSec = o.timeoutSec ?? VERIFY_TIMEOUT_SEC;
  const { check: reproduction, restored } = await checkReproduction(o, timeoutSec);
  const suite = await checkSuite(o, timeoutSec, restored);
  const checks = [reproduction, suite];
  const status = checks.some((c) => c.status === "fail")
    ? "failed"
    : reproduction.status === "pass"
      ? "verified"
      : "not_checked";
  return { status, reproduction, suite };
}

/** One line per check, for `report.md` and the PR reminders. */
export function describeCheck(name: string, check: Check): string {
  return check.status === "not_checked"
    ? `${name}: not checked (${check.reason})`
    : `${name}: ${check.status} — \`${check.cmd}\` ${check.detail}`;
}

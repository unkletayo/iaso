import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODO_MARK } from "./limits.js";

export interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a program on the host. Injected, so tests need neither GitHub nor the `gh` program. */
export type Runner = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string },
) => Promise<CmdResult>;

/** The real runner. No shell. A program that cannot start is exit code 127, not a thrown error. */
export const spawnRunner: Runner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (err as { code?: unknown }).code;
        resolve({
          exitCode: typeof code === "number" ? code : 127,
          stdout,
          stderr: stderr === "" ? err.message : stderr,
        });
      },
    );
  });

/** A step failed. `step` says which, so the message can say what was and was not done on GitHub. */
export class PublishError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

const STDERR_CHARS = 600;

export interface PublishInput {
  /** The project the pull request goes to. */
  upstream: { owner: string; repo: string };
  /** The commit the run started from; the patch applies on top of it. */
  baseCommit: string;
  patch: string;
  branch: string;
  /** Used as the pull request title and the commit message. */
  title: string;
  body: string;
  /** The commit author. Never invented: the caller reads it from git config. */
  identity: { name: string; email: string };
  /** Add a Signed-off-by line (the project asks for DCO). */
  signOff: boolean;
}

export interface Published {
  prUrl: string;
  /** `login/repo` the branch was pushed to. */
  fork: string;
  branch: string;
  /** The commit that was pushed. */
  commit: string;
}

const repoUrl = (owner: string, repo: string): string => `https://github.com/${owner}/${repo}.git`;

/**
 * Turn a patch into a draft pull request. The steps that only read or work in a temp folder come
 * first (fetch the base commit, apply the patch, commit), so a patch that does not apply never
 * creates a fork. Pushing uses `gh`'s credential helper for this one command: no token appears in
 * a command line, a URL or a config file. The pull request is always a draft.
 *
 * It does not decide whether a pull request is allowed (markers, daily limit, typed confirmation):
 * the caller does. It does refuse text that still has a `[TODO` marker, as a last stop.
 */
export async function publish(
  input: PublishInput,
  run: Runner = spawnRunner,
  log: (line: string) => void = () => undefined,
): Promise<Published> {
  if ((input.title + input.body).includes(TODO_MARK)) {
    throw new PublishError("check", `The title or body still has a ${TODO_MARK} marker.`);
  }
  const { upstream } = input;
  const work = await mkdtemp(join(tmpdir(), "iaso-publish-"));
  try {
    let login = "your-account";
    const step = async (
      name: string,
      command: string,
      args: readonly string[],
      cwd?: string,
    ): Promise<string> => {
      const r = await run(command, args, cwd === undefined ? {} : { cwd });
      if (r.exitCode !== 0) {
        const stale = r.stderr.includes("shallow update not allowed")
          ? ` The fork does not have the commit this change is based on, so it is probably out of date. Sync it (gh repo sync ${login}/${upstream.repo}) and run again.`
          : "";
        throw new PublishError(
          name,
          `${name} failed (${command} exit ${String(r.exitCode)}): ${r.stderr.trim().slice(0, STDERR_CHARS)}${stale}`,
        );
      }
      return r.stdout.trim();
    };

    login = await step("login", "gh", ["api", "user", "--jq", ".login"]);
    const base = await step("default branch", "gh", [
      "repo",
      "view",
      `${upstream.owner}/${upstream.repo}`,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);

    // Local work, in a temp folder.
    const repoDir = join(work, "repo");
    await mkdir(repoDir);
    const patchPath = join(work, "change.patch");
    await writeFile(patchPath, input.patch.endsWith("\n") ? input.patch : `${input.patch}\n`);
    await step("init", "git", ["init", "-q"], repoDir);
    log(`fetching ${input.baseCommit.slice(0, 12)} of ${upstream.owner}/${upstream.repo}`);
    await step(
      "fetch",
      "git",
      ["fetch", "-q", "--depth=1", repoUrl(upstream.owner, upstream.repo), input.baseCommit],
      repoDir,
    );
    await step("branch", "git", ["checkout", "-q", "-b", input.branch, "FETCH_HEAD"], repoDir);
    log("checking that the patch applies");
    await step("patch check", "git", ["apply", "--check", patchPath], repoDir);
    await step("patch", "git", ["apply", patchPath], repoDir);
    await step("stage", "git", ["add", "-A"], repoDir);
    await step(
      "commit",
      "git",
      [
        "-c",
        `user.name=${input.identity.name}`,
        "-c",
        `user.email=${input.identity.email}`,
        "commit",
        "-q",
        ...(input.signOff ? ["-s"] : []),
        "-m",
        input.title,
      ],
      repoDir,
    );
    const commit = await step("read commit", "git", ["rev-parse", "HEAD"], repoDir);

    // From here on, GitHub changes.
    log(`forking ${upstream.owner}/${upstream.repo} to ${login}`);
    await step("fork", "gh", [
      "repo",
      "fork",
      `${upstream.owner}/${upstream.repo}`,
      "--clone=false",
    ]);
    const parent = await step("fork check", "gh", [
      "repo",
      "view",
      `${login}/${upstream.repo}`,
      "--json",
      "parent",
      "--jq",
      '.parent.owner.login + "/" + .parent.name',
    ]);
    // Never push to a repository that is not a fork of the project (a same-named repo of yours).
    if (parent.toLowerCase() !== `${upstream.owner}/${upstream.repo}`.toLowerCase()) {
      throw new PublishError(
        "fork check",
        `${login}/${upstream.repo} is not a fork of ${upstream.owner}/${upstream.repo} (its parent is "${parent}"). Nothing was pushed.`,
      );
    }
    log(`pushing ${input.branch} to ${login}/${upstream.repo}`);
    await step(
      "push",
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "-q",
        repoUrl(login, upstream.repo),
        `${input.branch}:${input.branch}`,
      ],
      repoDir,
    );

    const bodyPath = join(work, "body.md");
    await writeFile(bodyPath, input.body);
    log("opening the draft pull request");
    const out = await step("pull request", "gh", [
      "pr",
      "create",
      "--draft",
      "--repo",
      `${upstream.owner}/${upstream.repo}`,
      "--base",
      base,
      "--head",
      `${login}:${input.branch}`,
      "--title",
      input.title,
      "--body-file",
      bodyPath,
    ]);
    const prUrl =
      out
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("https://")) ?? "";
    if (prUrl === "") {
      throw new PublishError(
        "pull request",
        `gh did not print a pull request URL. The branch ${input.branch} was pushed to ${login}/${upstream.repo}. Output: ${out.slice(0, STDERR_CHARS)}`,
      );
    }
    return { prUrl, fork: `${login}/${upstream.repo}`, branch: input.branch, commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { withRetry } from "../providers/retry.js";
import type { Source } from "./types.js";

const API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/** The issue body is cut here. */
export const MAX_BODY_CHARS = 20_000;
/** One comment is cut here. */
export const MAX_COMMENT_CHARS = 5_000;
/** All comments together stop here; later ones are counted, not shown. */
export const MAX_COMMENTS_CHARS = 30_000;

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface GithubIssue extends IssueRef {
  url: string;
  title: string;
  state: string;
  author: string;
  labels: string[];
  body: string;
  comments: IssueComment[];
  /** Comments that exist but are not in `comments`, because of the size cap. */
  omittedComments: number;
}

/** A GitHub API failure. `status` lets `withRetry` retry 429 and 5xx. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/** `git clone` failed. The message has the token removed. */
export class CloneError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CloneError";
  }
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Accepts `https://github.com/<owner>/<repo>/issues/<n>`. Pull requests and other hosts get a clear error. */
export function parseIssueUrl(input: string): IssueRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new GithubError(`Not a URL: ${input}`);
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) {
    throw new GithubError(`Not a github.com issue URL: ${input}`);
  }
  const [owner, repo, kind, number, ...rest] = url.pathname.split("/").filter((p) => p !== "");
  if (kind === "pull") {
    throw new GithubError(`${input} is a pull request. Pass an issue URL (…/issues/<number>).`);
  }
  const n = Number(number);
  if (
    owner === undefined ||
    repo === undefined ||
    !NAME.test(owner) ||
    !NAME.test(repo) ||
    kind !== "issues" ||
    !Number.isInteger(n) ||
    n < 1 ||
    rest.length > 0
  ) {
    throw new GithubError(
      `Expected https://github.com/<owner>/<repo>/issues/<number>, got: ${input}`,
    );
  }
  return { owner, repo, number: n };
}

const userSchema = z.object({ login: z.string() }).nullable();

const issueSchema = z.object({
  title: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  user: userSchema,
  comments: z.number().int().nonnegative(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  pull_request: z.unknown().optional(),
});

const commentsSchema = z.array(
  z.object({ user: userSchema, created_at: z.string(), body: z.string().nullable() }),
);

export interface FetchIssueOptions {
  /** Sent to api.github.com only. */
  token?: string | undefined;
  fetch?: typeof fetch;
  /** Retry options for tests. */
  retry?: Parameters<typeof withRetry>[1];
}

const login = (user: z.infer<typeof userSchema>): string => user?.login ?? "ghost";

const cut = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n[cut: ${String(text.length - max)} more characters]`;

function failure(res: Response, ref: IssueRef, hasToken: boolean): GithubError {
  const what = `${ref.owner}/${ref.repo}#${String(ref.number)}`;
  if (res.status === 404) {
    return new GithubError(
      `Issue not found: ${what}.${hasToken ? " Check the URL and that the token can read this repository." : " If the repository is private, set GITHUB_TOKEN."}`,
      404,
    );
  }
  if (res.status === 401) {
    return new GithubError("GitHub rejected GITHUB_TOKEN (401). Check that it is valid.", 401);
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const when =
        Number.isFinite(reset) && reset > 0
          ? ` Resets at ${new Date(reset * 1000).toISOString()}.`
          : "";
      return new GithubError(
        `GitHub rate limit reached.${when}${hasToken ? "" : " Set GITHUB_TOKEN for a higher limit."}`,
        // Not 429: waiting a few seconds does not help, so `withRetry` must not retry it.
        403,
      );
    }
    return new GithubError(`GitHub refused access to ${what} (403).`, 403);
  }
  return new GithubError(`GitHub API error ${String(res.status)} for ${what}.`, res.status);
}

/** GET a path of the REST API. Retries 5xx and 429; the token goes to api.github.com only. */
export async function getJson(path: string, ref: IssueRef, o: FetchIssueOptions): Promise<unknown> {
  const doFetch = o.fetch ?? fetch;
  return withRetry(async () => {
    const res = await doFetch(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "iaso",
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      },
    });
    if (!res.ok) throw failure(res, ref, Boolean(o.token));
    return res.json();
  }, o.retry);
}

/** Read an issue and its comments with the REST API. The token is sent to api.github.com and nowhere else. */
export async function fetchIssue(ref: IssueRef, o: FetchIssueOptions = {}): Promise<GithubIssue> {
  const base = `/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}`;
  const issue = issueSchema.parse(await getJson(base, ref, o));
  if (issue.pull_request !== undefined) {
    throw new GithubError(
      `${ref.owner}/${ref.repo}#${String(ref.number)} is a pull request. Pass an issue URL.`,
    );
  }

  const comments: IssueComment[] = [];
  let size = 0;
  let full = false;
  for (let page = 1; page <= MAX_PAGES && !full && comments.length < issue.comments; page += 1) {
    const batch = commentsSchema.parse(
      await getJson(`${base}/comments?per_page=${String(PAGE_SIZE)}&page=${String(page)}`, ref, o),
    );
    for (const c of batch) {
      const body = cut(c.body ?? "", MAX_COMMENT_CHARS);
      if (size + body.length > MAX_COMMENTS_CHARS) {
        full = true;
        break;
      }
      size += body.length;
      comments.push({ author: login(c.user), createdAt: c.created_at, body });
    }
    if (batch.length < PAGE_SIZE) break;
  }

  return {
    ...ref,
    url: issue.html_url,
    title: issue.title,
    state: issue.state,
    author: login(issue.user),
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    body: cut(issue.body ?? "", MAX_BODY_CHARS),
    comments,
    omittedComments: Math.max(0, issue.comments - comments.length),
  };
}

/** The issue as the agent sees it. The text is untrusted input; the agent prompt treats it as a bug report only. */
export function renderIssue(issue: GithubIssue): string {
  const head = [
    `# ${issue.title}`,
    `${issue.owner}/${issue.repo}#${String(issue.number)} (${issue.state}) by ${issue.author}${issue.labels.length > 0 ? `, labels: ${issue.labels.join(", ")}` : ""}`,
    issue.url,
    "",
    issue.body.trim() === "" ? "(no description)" : issue.body.trim(),
  ];
  const comments = issue.comments.map(
    (c) => `\n---\n**${c.author}** (${c.createdAt}):\n\n${c.body.trim()}`,
  );
  const omitted =
    issue.omittedComments > 0
      ? [`\n---\n[${String(issue.omittedComments)} more comments are not shown.]`]
      : [];
  return [...head, ...comments, ...omitted].join("\n");
}

/** Runs `git` on the host and returns stdout. Injected so tests can watch the arguments and environment. */
export type GitRunner = (
  args: readonly string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<string>;

const execFileAsync = promisify(execFile);

const runGit: GitRunner = async (args, opts) => {
  const { stdout } = await execFileAsync("git", [...args], {
    ...opts,
    timeout: CLONE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
};

/** Enough history for `git log` and `git blame` in the sandbox, which has no network. */
export const CLONE_DEPTH = 50;
const CLONE_TIMEOUT_MS = 5 * 60_000;

export interface GithubSourceOptions extends FetchIssueOptions {
  depth?: number;
  /** Where the temporary clone folder goes. */
  tmpRoot?: string;
  /** Test hook: clone from somewhere other than github.com. The token is not sent there. */
  cloneUrl?: (ref: IssueRef) => string;
  git?: GitRunner;
}

const githubCloneUrl = (ref: IssueRef): string => `https://github.com/${ref.owner}/${ref.repo}.git`;

/**
 * The token reaches git through its environment, as a header for this one process. It is not in the
 * arguments (visible in `ps`), the URL, or `.git/config` (which the sandbox gets a copy of).
 */
function gitEnv(token: string | undefined, sendToken: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (token && sendToken) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

/** Remove the token, in both forms, from text that may be shown to the user. */
function scrub(text: string, token: string | undefined): string {
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("[token]").split(basic).join("[token]");
}

/**
 * `--github <issue url>`: read the issue, then clone the default branch to a temporary folder.
 * The folder is removed by `cleanup`, and at once if the clone fails.
 */
export async function githubSource(issueUrl: string, o: GithubSourceOptions = {}): Promise<Source> {
  const ref = parseIssueUrl(issueUrl);
  const issue = await fetchIssue(ref, o);
  const git = o.git ?? runGit;
  const cloneUrl = (o.cloneUrl ?? githubCloneUrl)(ref);
  const sendToken = o.cloneUrl === undefined;

  const root = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "iaso-clone-"));
  const repoPath = join(root, ref.repo);
  const cleanup = (): Promise<void> => rm(root, { recursive: true, force: true });
  try {
    const env = gitEnv(o.token, sendToken);
    await git(
      [
        "clone",
        "--depth",
        String(o.depth ?? CLONE_DEPTH),
        "--single-branch",
        "--",
        cloneUrl,
        repoPath,
      ],
      { env },
    );
    const commit = (await git(["rev-parse", "HEAD"], { cwd: repoPath, env })).trim();
    return {
      repoPath,
      issue: renderIssue(issue),
      label: `${ref.owner}/${ref.repo}#${String(ref.number)}`,
      issueUrl: issue.url,
      commit,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    const detail = err instanceof Error ? err.message : String(err);
    throw new CloneError(
      `Could not clone ${ref.owner}/${ref.repo}: ${scrub(detail, o.token).split("\n").slice(0, 5).join(" ")}`,
      err,
    );
  }
}

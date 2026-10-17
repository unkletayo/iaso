import { z } from "zod";
import { withRetry } from "../providers/retry.js";

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

async function getJson(path: string, ref: IssueRef, o: FetchIssueOptions): Promise<unknown> {
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

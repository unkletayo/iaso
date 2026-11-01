import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Anything a person has to confirm or fill in is marked like this. Nothing is sent while one is left. */
export const TODO_MARK = "[TODO";

/** The most pull requests Iaso will open against one repository in 24 hours. Maintainers are people. */
export const MAX_PRS_PER_REPO_PER_DAY = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const OSS_LOG = "oss-log.jsonl";

/** One line of `oss-log.jsonl`: a pull request Iaso opened. */
export const ossLogEntrySchema = z.object({
  /** ISO time the pull request was opened. */
  at: z.string(),
  /** `owner/repo` of the project it was opened against. */
  repo: z.string(),
  runId: z.string(),
  prUrl: z.string(),
});
export type OssLogEntry = z.infer<typeof ossLogEntrySchema>;

/** Read the log. A missing file is empty; a line cut off by a crash or not matching is skipped. */
export async function readOssLog(runsDir: string): Promise<OssLogEntry[]> {
  let text: string;
  try {
    text = await readFile(join(runsDir, OSS_LOG), "utf8");
  } catch {
    return [];
  }
  const out: OssLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = ossLogEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A half-written line. Skipping it can only let one more pull request through, never block one.
    }
  }
  return out;
}

export async function appendOssLog(runsDir: string, entry: OssLogEntry): Promise<void> {
  await mkdir(runsDir, { recursive: true });
  await appendFile(join(runsDir, OSS_LOG), `${JSON.stringify(entry)}\n`, "utf8");
}

/** Pull requests opened against this repo in the 24 hours before `now`. GitHub names ignore case. */
export function recentPrs(entries: readonly OssLogEntry[], repo: string, now: Date): OssLogEntry[] {
  const key = repo.toLowerCase();
  const since = now.getTime() - DAY_MS;
  return entries.filter((e) => {
    const at = Date.parse(e.at);
    return e.repo.toLowerCase() === key && Number.isFinite(at) && at > since && at <= now.getTime();
  });
}

export interface PushCheckInput {
  repo: string;
  /** `[TODO` markers still in the draft. */
  todoCount: number;
  log: readonly OssLogEntry[];
  now: Date;
}

/** Why a pull request may not be opened right now. Empty means nothing stands in the way. */
export function pushBlockers({ repo, todoCount, log, now }: PushCheckInput): string[] {
  const blockers: string[] = [];
  if (todoCount > 0) {
    blockers.push(
      `${String(todoCount)} [TODO] marker(s) are left in the draft. Resolve each one: they are things only you can confirm.`,
    );
  }
  const recent = recentPrs(log, repo, now);
  if (recent.length >= MAX_PRS_PER_REPO_PER_DAY) {
    blockers.push(
      `Iaso already opened ${String(recent.length)} pull request(s) against ${repo} in the last 24 hours ` +
        `(the limit is ${String(MAX_PRS_PER_REPO_PER_DAY)}): ${recent.map((e) => e.prUrl).join(", ")}.`,
    );
  }
  return blockers;
}

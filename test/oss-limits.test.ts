import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_PRS_PER_REPO_PER_DAY,
  type OssLogEntry,
  appendOssLog,
  pushBlockers,
  readOssLog,
  recentPrs,
} from "../src/oss/limits.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const entry = (repo: string, at: string, n = 1): OssLogEntry => ({
  at,
  repo,
  runId: `run-${String(n)}`,
  prUrl: `https://github.com/${repo}/pull/${String(n)}`,
});

describe("recentPrs", () => {
  it("counts only this repo, within 24 hours, ignoring case", () => {
    const log = [
      entry("acme/widgets", hoursAgo(1), 1),
      entry("Acme/Widgets", hoursAgo(23), 2),
      entry("acme/widgets", hoursAgo(25), 3),
      entry("acme/other", hoursAgo(1), 4),
    ];
    expect(recentPrs(log, "ACME/widgets", NOW).map((e) => e.runId)).toEqual(["run-1", "run-2"]);
  });

  it("ignores an entry with an unreadable time or one in the future", () => {
    const log = [entry("a/b", "not a date"), entry("a/b", hoursAgo(-1))];
    expect(recentPrs(log, "a/b", NOW)).toEqual([]);
  });
});

describe("pushBlockers", () => {
  const base = { repo: "acme/widgets", runId: "this-run", todoCount: 0, log: [], now: NOW };

  it("has nothing to say when there is no marker and the limit is not reached", () => {
    expect(pushBlockers(base)).toEqual([]);
    expect(pushBlockers({ ...base, log: [entry("acme/widgets", hoursAgo(2))] })).toEqual([]);
  });

  it("blocks while a [TODO marker is left", () => {
    const [msg] = pushBlockers({ ...base, todoCount: 2 });
    expect(msg).toContain("2 [TODO] marker(s)");
  });

  it("blocks at the daily limit, naming the pull requests, and frees up after 24 hours", () => {
    const log = [entry("acme/widgets", hoursAgo(3), 1), entry("acme/widgets", hoursAgo(1), 2)];
    expect(MAX_PRS_PER_REPO_PER_DAY).toBe(2);
    const blockers = pushBlockers({ ...base, log });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("pull/1");
    expect(blockers[0]).toContain("pull/2");
    // 20 hours on, both are still inside the window; at 22 the older one has dropped out.
    const stillBlocked = new Date(NOW.getTime() + 20 * 3_600_000);
    expect(pushBlockers({ ...base, log, now: stillBlocked })).toHaveLength(1);
    const oneFree = new Date(NOW.getTime() + 22 * 3_600_000);
    expect(pushBlockers({ ...base, log, now: oneFree })).toEqual([]);
  });

  it("blocks a second pull request for the same run, naming the first", () => {
    const log = [{ ...entry("acme/widgets", hoursAgo(30), 7), runId: "this-run" }];
    const [msg] = pushBlockers({ ...base, log });
    expect(msg).toContain("already opened for this run");
    expect(msg).toContain("pull/7");
  });

  it("does not count other repositories against the limit", () => {
    const log = [entry("acme/a", hoursAgo(1), 1), entry("acme/b", hoursAgo(1), 2)];
    expect(pushBlockers({ ...base, log, repo: "acme/c" })).toEqual([]);
  });
});

describe("the log file", () => {
  it("is empty when missing, appends one line per entry, and skips a damaged line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iaso-oss-"));
    expect(await readOssLog(dir)).toEqual([]);
    await appendOssLog(dir, entry("a/b", hoursAgo(1), 1));
    await appendOssLog(dir, entry("a/b", hoursAgo(2), 2));
    const path = join(dir, "oss-log.jsonl");
    await writeFile(
      path,
      `${await readFile(path, "utf8")}{"at":"2026-11\n{"unexpected":true}\n`,
      "utf8",
    );
    expect((await readOssLog(dir)).map((e) => e.runId)).toEqual(["run-1", "run-2"]);
  });

  it("creates the runs folder if it is not there yet", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "iaso-oss-")), "not", "yet");
    await appendOssLog(dir, entry("a/b", hoursAgo(1)));
    expect(await readOssLog(dir)).toHaveLength(1);
  });
});

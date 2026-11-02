import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import {
  type FindCommandDeps,
  type FindCommandOptions,
  executeFind,
  registerFind,
  renderFind,
} from "../src/commands/find.js";
import type { Candidate, FindOptions, FindResult } from "../src/oss/find.js";

const candidate = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  url: `https://github.com/acme/widgets/issues/${String(n)}`,
  repo: { fullName: "acme/widgets", stars: 2000, license: "MIT", merged: 20, externalMerged: 10 },
  number: n,
  title: `Issue ${String(n)}`,
  comments: 1,
  updatedAt: "2026-10-28T00:00:00Z",
  score: 80 - n,
  reasons: ["20 pull requests merged", "2000 stars"],
  claim: { blockers: [], warnings: [] },
  copyleft: false,
  licenseUnclear: false,
  ...over,
});

const result = (over: Partial<FindResult> = {}): FindResult => ({
  candidates: [candidate(1), candidate(2), candidate(3)],
  skipped: [{ what: "acme/quiet", reason: "only 1 pull request(s) merged lately (needs 5)" }],
  repos: 4,
  issues: 9,
  ...over,
});

const opts = (over: Partial<FindCommandOptions> = {}): FindCommandOptions => ({
  minStars: 200,
  limit: 10,
  window: 30,
  ...over,
});

function deps(r: FindResult = result(), token: string | undefined = "t") {
  const lines: string[] = [];
  const seen: FindOptions[] = [];
  const d: FindCommandDeps = {
    find: (o) => {
      seen.push(o);
      return Promise.resolve(r);
    },
    log: (l) => lines.push(l),
    progress: () => undefined,
    token,
  };
  return { d, lines, seen, text: () => lines.join("\n") };
}

describe("renderFind", () => {
  const base = { limit: 10, showSkipped: false, hasToken: true };

  it("lists each issue with its score, URL, title, reasons and notes", () => {
    const text = renderFind(
      result({ candidates: [candidate(1, { claim: { blockers: [], warnings: ["an old PR"] } })] }),
      base,
    );
    expect(text).toContain(" 1. score 79  https://github.com/acme/widgets/issues/1");
    expect(text).toContain("    Issue 1");
    expect(text).toContain("20 pull requests merged; 2000 stars");
    expect(text).toContain("    note: an old PR");
    expect(text).toContain("Looked at 9 issue(s) in 4 project(s); 1 passed, 1 dropped.");
  });

  it("marks an issue in a copyleft project next to its score", () => {
    const text = renderFind(result({ candidates: [candidate(1, { copyleft: true })] }), base);
    expect(text).toContain("score 79 [copyleft licence]  https://github.com/acme/widgets/issues/1");
    expect(renderFind(result(), base)).not.toContain("copyleft");
  });

  it("marks a project whose licence GitHub could not classify", () => {
    const text = renderFind(result({ candidates: [candidate(1, { licenseUnclear: true })] }), base);
    expect(text).toContain("score 79 [licence unclear]  https://github.com/acme/widgets/issues/1");
  });

  it("shows only `limit` issues and says so", () => {
    const text = renderFind(result(), { ...base, limit: 2 });
    expect(text).toContain("Issue 2");
    expect(text).not.toContain("Issue 3");
    expect(text).toContain("3 passed, 1 dropped; showing 2.");
  });

  it("says plainly when nothing passed", () => {
    const text = renderFind(result({ candidates: [] }), base);
    expect(text).toContain("No issue passed the checks.");
  });

  it("hides the dropped list unless asked, and then gives the reasons", () => {
    expect(renderFind(result(), base)).toContain("Add --show-skipped");
    const text = renderFind(result(), { ...base, showSkipped: true });
    expect(text).toContain("dropped acme/quiet: only 1 pull request(s) merged lately");
    expect(text).not.toContain("Add --show-skipped");
  });

  it("warns about the rate limit without a token, and not with one", () => {
    const text = renderFind(result(), { ...base, hasToken: false });
    expect(text).toContain("No GITHUB_TOKEN");
    expect(text).toContain("60 other calls an hour");
    expect(renderFind(result(), base)).not.toContain("No GITHUB_TOKEN");
  });

  it("always says it did not read the AI policy, and what to do before spending", () => {
    const text = renderFind(result(), base);
    expect(text).toContain("did not read any project's AI policy");
    expect(text).toContain("iaso run --github <issue url> --max-cost 1");
  });
});

describe("executeFind", () => {
  it("passes the options and the token to the search", async () => {
    const d = deps();
    await executeFind(opts({ language: "python", minStars: 500, maxRepos: 5, window: 14 }), d.d);
    expect(typeof d.seen[0]?.progress).toBe("function");
    expect(d.seen.map((o) => ({ ...o, progress: undefined }))).toEqual([
      {
        token: "t",
        minStars: 500,
        windowDays: 14,
        language: "python",
        maxRepos: 5,
      },
    ]);
  });

  it("leaves unset options out", async () => {
    const d = deps();
    await executeFind(opts(), d.d);
    expect(typeof d.seen[0]?.progress).toBe("function");
    expect({ ...d.seen[0], progress: undefined }).toEqual({
      token: "t",
      progress: undefined,
      minStars: 200,
      windowDays: 30,
    });
  });

  it("prints JSON, cut to the limit, with --json", async () => {
    const d = deps();
    await executeFind(opts({ json: true, limit: 2 }), d.d);
    const out = JSON.parse(d.text()) as FindResult;
    expect(out.candidates).toHaveLength(2);
    expect(out.skipped).toHaveLength(1);
  });

  it("prints the text report otherwise, and knows when there is no token", async () => {
    const d = deps();
    d.d.token = undefined;
    await executeFind(opts(), d.d);
    expect(d.text()).toContain("score 79");
    expect(d.text()).toContain("No GITHUB_TOKEN");
    const empty = deps(result(), "");
    await executeFind(opts(), empty.d);
    expect(empty.text()).toContain("No GITHUB_TOKEN");
  });
});

describe("iaso find options", () => {
  function parse(args: string[]) {
    const d = deps();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerFind(program, () => d.d);
    return { run: () => program.parseAsync(["node", "iaso", "find", ...args]), d };
  }

  it("reads the flags", async () => {
    const p = parse([
      "--language",
      "typescript",
      "--min-stars",
      "800",
      "--max-repos",
      "3",
      "--window",
      "7",
    ]);
    await p.run();
    expect({ ...p.d.seen[0], progress: undefined }).toEqual({
      token: "t",
      progress: undefined,
      minStars: 800,
      windowDays: 7,
      language: "typescript",
      maxRepos: 3,
    });
  });

  it.each([
    ["--min-stars", "0"],
    ["--limit", "abc"],
    ["--max-repos", "1.5"],
    ["--window", "-2"],
  ])("refuses %s %s before searching", async (flag, value) => {
    const p = parse([flag, value]);
    await expect(p.run()).rejects.toThrow(/whole number above 0/);
    expect(p.d.seen).toEqual([]);
  });

  it("is part of the program", () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain("find");
  });
});

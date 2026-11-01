import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "../src/agent/pipeline.js";
import { runInfoSchema, writeReport } from "../src/agent/report.js";
import {
  PrError,
  type PrCommandDeps,
  type SavedConventions,
  buildDraft,
  executePr,
  hasTodo,
  parseDraftFile,
  renderDraftFile,
  summariseDiff,
} from "../src/commands/pr.js";
import { emptyTaskState } from "../src/context/state.js";
import { appendOssLog, readOssLog } from "../src/oss/limits.js";
import type { PublishInput } from "../src/oss/publish.js";

const ISSUE_URL = "https://github.com/acme/widgets/issues/46";
const DIFF =
  "diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n";

const TEMPLATE =
  "## Description\n\n- [ ] I have signed the CLA\n- [ ] I reviewed any AI-generated edits\n";

const conventions: SavedConventions = {
  commitStyle: "conventional",
  dco: true,
  cla: true,
  changelog: true,
  aiPolicy: {
    verdict: "disclosure",
    requiresDisclosure: true,
    excerpts: [
      {
        path: ".github/PULL_REQUEST_TEMPLATE.md",
        line: 19,
        text: "- [ ] If the PR includes AI-generated edits, I have reviewed it.",
      },
    ],
  },
  prTemplate: { path: ".github/PULL_REQUEST_TEMPLATE.md", text: TEMPLATE },
};

function result(over: Partial<PipelineResult> = {}): PipelineResult {
  return {
    status: "submitted",
    planCostUsd: 0.01,
    planSteps: 3,
    costUsd: 0.2,
    steps: 14,
    diff: DIFF,
    fix: {
      status: "submitted",
      steps: 11,
      compactions: 0,
      costUsd: 0.19,
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      submission: {
        summary: "Added the clock widget.",
        prTitle: "Add a clock widget",
        prSummary: "Adds a clock widget to the powerline.",
        assumptions: [],
        testsAdded: ["tests/clock.js"],
        confidence: "high",
        step: 11,
      },
      state: { ...emptyTaskState(), testsRun: [{ cmd: "node --test", result: "pass", step: 9 }] },
      diff: DIFF,
    },
    ...over,
  };
}

interface Made {
  runs: string;
  runId: string;
  dir: string;
}

async function makeRun(
  opts: {
    result?: PipelineResult;
    issue?: string;
    source?: { label: string; issueUrl?: string; commit?: string } | null;
    conventions?: SavedConventions | null;
  } = {},
): Promise<Made> {
  const runs = await mkdtemp(join(tmpdir(), "iaso-pr-"));
  const runId = "20261022T120000-ab12";
  const dir = join(runs, runId);
  await mkdir(dir, { recursive: true });
  await writeReport(dir, {
    runId,
    issue: opts.issue ?? "# Add a clock widget\nacme/widgets#46 (open)\n\nShow the time.",
    model: "anthropic:claude-haiku-5-5",
    ...(opts.source === null
      ? {}
      : {
          source: opts.source ?? {
            label: "acme/widgets#46",
            issueUrl: ISSUE_URL,
            commit: "a".repeat(40),
          },
        }),
    elapsedMs: 1000,
    result: opts.result ?? result(),
  });
  if (opts.conventions !== null) {
    await writeFile(join(dir, "conventions.json"), JSON.stringify(opts.conventions ?? conventions));
  }
  return { runs, runId, dir };
}

function deps(
  identity: { name: string; email: string } | null = { name: "Ada", email: "ada@example.com" },
) {
  const lines: string[] = [];
  const state: {
    answer: string | undefined;
    asked: string[];
    published: PublishInput[];
    publishError?: Error;
  } = { answer: undefined, asked: [], published: [] };
  const d: PrCommandDeps = {
    gitIdentity: () => Promise.resolve(identity ?? undefined),
    log: (l) => lines.push(l),
    author: (o) =>
      Promise.resolve({
        name: o.name ?? "Ada",
        email: o.email ?? "1+ada@users.noreply.github.com",
      }),
    ask: (q) => {
      state.asked.push(q);
      return Promise.resolve(state.answer);
    },
    publish: (input) => {
      state.published.push(input);
      if (state.publishError) return Promise.reject(state.publishError);
      return Promise.resolve({
        prUrl: "https://github.com/acme/widgets/pull/9",
        fork: "ada/widgets",
        branch: input.branch,
        commit: "c".repeat(40),
      });
    },
  };
  return { d, lines, state, text: () => lines.join("\n") };
}

const opts = (
  m: Made,
  over: Partial<{
    title: string;
    redo: boolean;
    diff: boolean;
    push: boolean;
    name: string;
    email: string;
  }> = {},
) => ({
  runs: m.runs,
  diff: true,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run.json", () => {
  it("is written beside the report, with the facts `iaso pr` needs", async () => {
    const m = await makeRun();
    const info = runInfoSchema.parse(JSON.parse(await readFile(join(m.dir, "run.json"), "utf8")));
    expect(info).toMatchObject({
      runId: m.runId,
      status: "submitted",
      steps: 14,
      issueTitle: "Add a clock widget",
      summary: "Added the clock widget.",
      prTitle: "Add a clock widget",
      prSummary: "Adds a clock widget to the powerline.",
      assumptions: [],
      testsAdded: ["tests/clock.js"],
      confidence: "high",
      testsRun: [{ cmd: "node --test", result: "pass", step: 9 }],
      source: { label: "acme/widgets#46", issueUrl: ISSUE_URL },
    });
    expect(info.patchBytes).toBe(Buffer.byteLength(DIFF));
  });
});

describe("summariseDiff", () => {
  it("counts added and removed lines per file, and not the file headers", () => {
    const diff =
      "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-x\n+y\n+z\n" +
      "diff --git a/b.sql b/b.sql\n--- a/b.sql\n+++ b/b.sql\n@@ -1 +1 @@\n--- a comment\n+-- another\n" +
      "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    expect(summariseDiff(diff)).toEqual([
      { path: "a.js", added: 2, removed: 1 },
      { path: "b.sql", added: 1, removed: 1 },
      { path: "img.png", added: 0, removed: 0 },
    ]);
  });

  it("finds nothing in an empty diff", () => {
    expect(summariseDiff("")).toEqual([]);
  });
});

describe("iaso pr: the draft", () => {
  it("shows what would be sent, saves it for editing, and sends nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("the network must not be used");
    });
    const m = await makeRun();
    const o = deps();
    await executePr(m.runId, opts(m), o.d);
    const out = o.text();

    expect(out).toContain("Issue:  https://github.com/acme/widgets/issues/46");
    expect(out).toContain(`Base:   ${"a".repeat(40)} of acme/widgets`);
    expect(out).toContain("+1 -1  src/a.js");
    expect(out).toContain("-old\n+new");
    expect(out).toContain("Title: feat: add a clock widget");
    expect(out).toContain("Closes #46");
    // The agent's test notes go to you as a reminder, not into the text a maintainer reads.
    expect(out).toContain("node --test (pass)");
    expect(out).toContain("Nothing was sent to GitHub.");
    expect(fetchSpy).not.toHaveBeenCalled();

    // The only new file is the draft.
    expect((await readdir(m.dir)).sort()).toEqual([
      "conventions.json",
      "patch.diff",
      "pr-draft.md",
      "report.md",
      "run.json",
    ]);
    const draft = parseDraftFile(await readFile(join(m.dir, "pr-draft.md"), "utf8"));
    expect(draft.title).toBe("feat: add a clock widget");
    expect(draft.body).toContain("Adds a clock widget to the powerline.");
    expect(draft.body).not.toContain("node --test");
  });

  it("claims nothing a person has not done: the disclosure and tests are markers, and no box is ticked", async () => {
    const m = await makeRun();
    const o = deps();
    await executePr(m.runId, opts(m), o.d);
    const { body } = parseDraftFile(await readFile(join(m.dir, "pr-draft.md"), "utf8"));

    expect(hasTodo(body)).toBe(true);
    expect(body).toMatch(
      /\[TODO: confirm this is true, then remove this marker\] This change was made with Iaso/,
    );
    expect(body).toContain("[TODO: run the project's own tests and lint yourself");
    expect(body).toContain("[TODO: tick only what is true for you. Iaso ticks nothing]");
    // The template is copied as it is, with every box still empty.
    expect(body).toContain(TEMPLATE.trim());
    expect(body).not.toMatch(/\[[xX]\]/);
    expect(o.text()).toMatch(/3 \[TODO\] marker\(s\) left/);
  });

  it("tells you what the project asks of you that Iaso cannot do", async () => {
    const m = await makeRun();
    const o = deps();
    await executePr(m.runId, opts(m), o.d);
    const out = o.text();
    expect(out).toContain("Only you can sign it");
    expect(out).toContain(
      "Signed-off-by line. It will use your git identity: Ada <ada@example.com>",
    );
    expect(out).toContain("mentions a changelog or changesets, and this patch adds none");
    expect(out).toContain("AI policy (disclosure, disclosure required). Read it:");
    expect(out).toContain(
      "PULL_REQUEST_TEMPLATE.md:19: - [ ] If the PR includes AI-generated edits",
    );
    expect(out).toContain("its own opinion");
  });

  it("drops the reminders and sections that do not apply", async () => {
    const plain: SavedConventions = {
      commitStyle: null,
      dco: false,
      cla: false,
      changelog: true,
      aiPolicy: { verdict: "none", requiresDisclosure: false, excerpts: [] },
      prTemplate: null,
    };
    const m = await makeRun({
      conventions: plain,
      result: result({
        diff: `${DIFF}diff --git a/CHANGELOG.md b/CHANGELOG.md\n@@ -1 +1,2 @@\n a\n+b\n`,
      }),
    });
    const o = deps();
    await executePr(m.runId, opts(m), o.d);
    const { title, body } = parseDraftFile(await readFile(join(m.dir, "pr-draft.md"), "utf8"));
    expect(title).toBe("Add a clock widget");
    expect(body).not.toContain("## AI assistance");
    expect(body).not.toContain("## Project checklist");
    const out = o.text();
    expect(out).not.toContain("CLA");
    expect(out).not.toContain("Signed-off-by");
    expect(out).not.toContain("changelog or changesets");
    expect(out).not.toContain("AI policy (");
  });

  it("warns when sign-off is needed but git has no name and email", async () => {
    const m = await makeRun();
    const o = deps(null);
    await executePr(m.runId, opts(m), o.d);
    expect(o.text()).toContain("your git name and email are not set");
  });

  it("still drafts, with a warning, when the project's rules were never read", async () => {
    const m = await makeRun({ conventions: null });
    const o = deps();
    await executePr(m.runId, opts(m), o.d);
    expect(o.text()).toContain("No conventions.json for this run");
  });

  it("makes the title from the issue, and leaves one that is already conventional alone", () => {
    const info = (issueTitle?: string) => ({
      runId: "r",
      model: "m",
      status: "submitted",
      steps: 1,
      costUsd: 0,
      elapsedMs: 1,
      source: { label: "a/b#1", issueUrl: "https://github.com/a/b/issues/1" },
      ...(issueTitle === undefined ? {} : { issueTitle }),
      assumptions: [],
      testsAdded: [],
      testsRun: [],
      patchBytes: 1,
    });
    const title = (t: string | undefined, override?: string) =>
      buildDraft(info(t), DIFF, conventions, undefined, override).title;
    expect(title("Dashboard counts are wrong")).toBe("fix: dashboard counts are wrong");
    expect(title("Add a clock widget")).toBe("feat: add a clock widget");
    expect(title("fix(runtime): exit quietly on EPIPE")).toBe(
      "fix(runtime): exit quietly on EPIPE",
    );
    expect(title(undefined)).toContain("[TODO: write a title]");
    expect(title("Whatever", "chore: my own title")).toBe("chore: my own title");
  });

  it("uses the agent's PR title and summary, and falls back to the issue for older runs", () => {
    const base = {
      runId: "r",
      model: "m",
      status: "submitted",
      steps: 1,
      costUsd: 0,
      elapsedMs: 1,
      source: { label: "a/b#1", issueUrl: "https://github.com/a/b/issues/1" },
      issueTitle: "Crash when the list is empty",
      summary: "agent notes",
      assumptions: [],
      testsAdded: [],
      testsRun: [],
      patchBytes: 1,
    };
    const fresh = buildDraft(
      { ...base, prTitle: "Handle an empty list in sum", prSummary: "sum() now returns 0." },
      DIFF,
      conventions,
      undefined,
    );
    expect(fresh.title).toBe("fix: handle an empty list in sum");
    expect(fresh.body).toContain("sum() now returns 0.");
    expect(fresh.body).not.toContain("agent notes");

    const old = buildDraft(base, DIFF, conventions, undefined);
    expect(old.title).toBe("fix: crash when the list is empty");
    expect(old.body).toContain("agent notes");
  });

  it("lists the agent's assumptions behind a marker, and omits the section when there are none", () => {
    const info = {
      runId: "r",
      model: "m",
      status: "submitted",
      steps: 1,
      costUsd: 0,
      elapsedMs: 1,
      source: { label: "a/b#1", issueUrl: "https://github.com/a/b/issues/1" },
      testsAdded: [],
      testsRun: [],
      patchBytes: 1,
    };
    const some = buildDraft(
      { ...info, assumptions: ["An empty list returns 0."] },
      DIFF,
      conventions,
      undefined,
    );
    expect(some.body).toContain("## Choices the issue did not settle");
    expect(some.body).toContain("- An empty list returns 0.");
    expect(some.body).toMatch(/\[TODO: check each of these/);
    expect(
      buildDraft({ ...info, assumptions: [] }, DIFF, conventions, undefined).body,
    ).not.toContain("did not settle");
  });

  it("says what stands in the way of opening it: markers left, and the daily limit", async () => {
    const m = await makeRun();
    const first = deps();
    await executePr(m.runId, opts(m), first.d);
    expect(first.text()).toContain("Pull requests to acme/widgets in the last 24 hours: 0 of 2");
    expect(first.text()).toContain("Not ready to open:");
    expect(first.text()).toMatch(/\d+ \[TODO\] marker\(s\) are left/);

    // Resolve every marker by hand, as a person would.
    const path = join(m.dir, "pr-draft.md");
    const text = (await readFile(path, "utf8")).replace(/\[TODO[^\]]*\]/g, "done");
    await writeFile(path, text, "utf8");
    const clear = deps();
    await executePr(m.runId, opts(m), clear.d);
    expect(clear.text()).toContain("Nothing in the way of opening the pull request.");

    const now = new Date("2026-11-01T12:00:00Z");
    for (const n of [1, 2]) {
      await appendOssLog(m.runs, {
        at: new Date(now.getTime() - n * 3_600_000).toISOString(),
        repo: "acme/widgets",
        runId: `earlier-${String(n)}`,
        prUrl: `https://github.com/acme/widgets/pull/${String(n)}`,
      });
    }
    const limited = deps();
    await executePr(m.runId, opts(m), { ...limited.d, now: () => now });
    expect(limited.text()).toContain("in the last 24 hours: 2 of 2");
    expect(limited.text()).toContain("already opened 2 pull request(s)");
  });

  it("keeps a draft you have edited, and rebuilds it only with --redo", async () => {
    const m = await makeRun();
    await executePr(m.runId, opts(m), deps().d);
    const file = join(m.dir, "pr-draft.md");
    await writeFile(file, "my own title\n\nmy own body, edited by me\n");

    const again = deps();
    await executePr(m.runId, opts(m), again.d);
    expect(again.text()).toContain("kept from an earlier call");
    expect(again.text()).toContain("Title: my own title");
    expect(await readFile(file, "utf8")).toBe("my own title\n\nmy own body, edited by me\n");

    const redo = deps();
    await executePr(m.runId, opts(m, { redo: true }), redo.d);
    expect(await readFile(file, "utf8")).toContain("feat: add a clock widget");
  });

  it("uses --title, and leaves the diff out with --no-diff", async () => {
    const m = await makeRun();
    const o = deps();
    await executePr(m.runId, opts(m, { title: "fix: a title I chose", diff: false }), o.d);
    expect(o.text()).toContain("Title: fix: a title I chose");
    expect(o.text()).not.toContain("-old\n+new");
    expect(o.text()).toContain("+1 -1  src/a.js");
  });

  it("round-trips the draft file", () => {
    const text = renderDraftFile({ title: "t", body: "line 1\n\nline 2" });
    expect(parseDraftFile(text)).toEqual({ title: "t", body: "line 1\n\nline 2" });
    expect(hasTodo("all done")).toBe(false);
  });
});

describe("iaso pr: runs it will not turn into a pull request", () => {
  const refuses = async (m: Made, message: RegExp) => {
    const o = deps();
    const err = await executePr(m.runId, opts(m), o.d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrError);
    expect((err as Error).message).toMatch(message);
    await expect(readFile(join(m.dir, "pr-draft.md"), "utf8")).rejects.toThrow();
  };

  it("a run that did not submit", async () => {
    await refuses(
      await makeRun({ result: result({ status: "budget_exceeded" }) }),
      /ended as "budget_exceeded", not "submitted"/,
    );
  });

  it("an empty patch", async () => {
    await refuses(await makeRun({ result: result({ diff: "" }) }), /patch is empty/);
  });

  it("a run that did not come from a GitHub issue", async () => {
    await refuses(
      await makeRun({ source: { label: "local" } }),
      /did not come from a GitHub issue/,
    );
    await refuses(await makeRun({ source: null }), /did not come from a GitHub issue/);
  });

  it("a project whose rules appear to ban AI-generated contributions, quoting the lines", async () => {
    const banned: SavedConventions = {
      ...conventions,
      aiPolicy: {
        verdict: "banned",
        requiresDisclosure: false,
        excerpts: [
          { path: "CONTRIBUTING.md", line: 3, text: "We do not accept AI-generated code." },
        ],
      },
    };
    await refuses(
      await makeRun({ conventions: banned }),
      /appear to forbid AI-generated contributions[\s\S]*CONTRIBUTING\.md:3: We do not accept AI-generated code\./,
    );
  });

  it("a run id with no run.json", async () => {
    const runs = await mkdtemp(join(tmpdir(), "iaso-pr-"));
    const err = await executePr("nope", { runs, diff: true }, deps().d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrError);
    expect((err as Error).message).toContain("No run.json");
  });
});

/** Write the draft, then resolve every marker by hand, as a person would. */
async function readyDraft(m: Made): Promise<void> {
  await executePr(m.runId, opts(m), deps().d);
  const path = join(m.dir, "pr-draft.md");
  const text = (await readFile(path, "utf8")).replace(/\[TODO[^\]]*\]/g, "done");
  await writeFile(path, text, "utf8");
}

describe("iaso pr --push", () => {
  it("sends nothing without --push, and says how", async () => {
    const m = await makeRun();
    await readyDraft(m);
    const o = deps();
    await executePr(m.runId, opts(m), o.d);
    expect(o.text()).toContain("Add --push");
    expect(o.state.published).toEqual([]);
    expect(o.state.asked).toEqual([]);
  });

  it("refuses while a [TODO marker is left, and does not even ask", async () => {
    const m = await makeRun();
    const o = deps();
    await expect(executePr(m.runId, opts(m, { push: true }), o.d)).rejects.toThrow(/Not pushing/);
    expect(o.state.asked).toEqual([]);
    expect(o.state.published).toEqual([]);
  });

  it.each([undefined, "", "yes", "acme", "acme/other"])(
    "cancels on the answer %j and sends nothing",
    async (answer) => {
      const m = await makeRun();
      await readyDraft(m);
      const o = deps();
      o.state.answer = answer;
      await expect(executePr(m.runId, opts(m, { push: true }), o.d)).rejects.toThrow(
        /Cancelled|no terminal/,
      );
      expect(o.state.asked).toHaveLength(1);
      expect(o.state.asked[0]).toContain("acme/widgets");
      expect(o.state.published).toEqual([]);
      expect(await readOssLog(m.runs)).toEqual([]);
    },
  );

  it("shows what will happen, publishes on the typed repository name, and logs the pull request", async () => {
    const m = await makeRun();
    await readyDraft(m);
    const o = deps();
    o.state.answer = "  ACME/Widgets ";
    await executePr(m.runId, opts(m, { push: true }), o.d);

    expect(o.text()).toContain("About to do this on GitHub:");
    expect(o.text()).toContain("DRAFT pull request against acme/widgets");
    expect(o.text()).toContain("Ada <1+ada@users.noreply.github.com> (with Signed-off-by)");
    expect(o.text()).toContain(
      "Opened a draft pull request: https://github.com/acme/widgets/pull/9",
    );

    expect(o.state.published).toHaveLength(1);
    const sent = o.state.published[0];
    expect(sent).toMatchObject({
      upstream: { owner: "acme", repo: "widgets" },
      baseCommit: "a".repeat(40),
      patch: DIFF,
      signOff: true,
      identity: { name: "Ada", email: "1+ada@users.noreply.github.com" },
    });
    expect(sent?.branch).toBe("iaso/issue-46-ab12");
    expect(hasTodo((sent?.title ?? "") + (sent?.body ?? ""))).toBe(false);

    expect(await readOssLog(m.runs)).toMatchObject([
      { repo: "acme/widgets", runId: m.runId, prUrl: "https://github.com/acme/widgets/pull/9" },
    ]);
  });

  it("uses the name and email you pass instead of the defaults", async () => {
    const m = await makeRun();
    await readyDraft(m);
    const o = deps();
    o.state.answer = "acme/widgets";
    await executePr(m.runId, opts(m, { push: true, name: "Grace", email: "g@example.com" }), o.d);
    expect(o.state.published[0]?.identity).toEqual({ name: "Grace", email: "g@example.com" });
  });

  it("opens only one pull request for a run", async () => {
    const m = await makeRun();
    await readyDraft(m);
    const o = deps();
    o.state.answer = "acme/widgets";
    await executePr(m.runId, opts(m, { push: true }), o.d);
    const again = deps();
    again.state.answer = "acme/widgets";
    await expect(executePr(m.runId, opts(m, { push: true }), again.d)).rejects.toThrow(
      /Not pushing/,
    );
    expect(again.text()).toContain("already opened for this run");
    expect(again.state.published).toEqual([]);
  });

  it("stops at the daily limit", async () => {
    const m = await makeRun();
    await readyDraft(m);
    const now = new Date("2026-11-01T12:00:00Z");
    for (const n of [1, 2]) {
      await appendOssLog(m.runs, {
        at: new Date(now.getTime() - n * 3_600_000).toISOString(),
        repo: "acme/widgets",
        runId: `earlier-${String(n)}`,
        prUrl: `https://github.com/acme/widgets/pull/${String(n)}`,
      });
    }
    const o = deps();
    o.state.answer = "acme/widgets";
    await expect(
      executePr(m.runId, opts(m, { push: true }), { ...o.d, now: () => now }),
    ).rejects.toThrow(/Not pushing/);
    expect(o.state.asked).toEqual([]);
    expect(o.state.published).toEqual([]);
  });

  it("logs nothing when publishing fails, and says so", async () => {
    const m = await makeRun();
    await readyDraft(m);
    const o = deps();
    o.state.answer = "acme/widgets";
    o.state.publishError = new Error("fork failed (gh exit 1): boom");
    await expect(executePr(m.runId, opts(m, { push: true }), o.d)).rejects.toThrow(/boom/);
    expect(await readOssLog(m.runs)).toEqual([]);
  });
});

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import {
  type CommandDeps,
  type RunCommandOptions,
  chooseSource,
  defaultCompactModel,
  defaultResolveSource,
  executeCommand,
  newRunId,
  parseReview,
  registerRun,
} from "../src/commands/run.js";
import { Command } from "commander";
import { loadCatalogue } from "../src/models.js";
import { AiPolicyError } from "../src/oss/conventions.js";
import { MockProvider, mockToolCall } from "../src/providers/mock.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const plan = {
  rootCauseHypothesis: "off by one",
  filesToChange: [{ path: "a.js", change: "x" }],
  testPlan: "t",
  risks: [],
  steps: ["s"],
};
const submit = mockToolCall("s", "submit", {
  summary: "done",
  prTitle: "Fix it",
  prSummary: "Fixes it.",
  testsAdded: [],
  confidence: "high",
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "iaso-cmd-"));
  await mkdir(join(dir, "repo"));
  await writeFile(join(dir, "issue.md"), "the bug");
  const opts: RunCommandOptions = {
    repo: join(dir, "repo"),
    issue: join(dir, "issue.md"),
    model: "anthropic:claude-haiku-5-5",
    plan: true,
    maxSteps: 50,
    maxCost: 1,
    maxTime: 20,
    runs: join(dir, "runs"),
  };
  return { dir, opts };
}

function deps(provider: MockProvider): { deps: CommandDeps; lines: string[] } {
  const lines: string[] = [];
  const fake = fakeSandbox();
  return {
    lines,
    deps: {
      checkClaim: () => Promise.resolve({ blockers: [], warnings: [] }),
      resolveSource: defaultResolveSource,
      createProvider: () => provider,
      createSandbox: () => fake.sandbox,
      review: vi.fn(() => Promise.resolve({ kind: "approve" as const })),
      log: (l) => lines.push(l),
    },
  };
}

describe("parseReview", () => {
  it("maps y, n and feedback", () => {
    expect(parseReview("y", true)).toEqual({ kind: "approve" });
    expect(parseReview(" YES ", true)).toEqual({ kind: "approve" });
    expect(parseReview("n", true)).toEqual({ kind: "reject" });
    expect(parseReview("also check negatives", true)).toEqual({
      kind: "feedback",
      text: "also check negatives",
    });
  });

  it("asks again on empty input, and on feedback when no revision is possible", () => {
    expect(parseReview("", true)).toBeNull();
    expect(parseReview("more", false)).toBeNull();
  });
});

describe("newRunId", () => {
  it("is a valid container-name suffix and sorts by time", () => {
    const id = newRunId(new Date("2026-10-16T17:05:09Z"));
    expect(id).toMatch(/^20261016T170509-[0-9a-f]{4}$/);
  });
});

describe("executeCommand", () => {
  it("run: plans, fixes, and writes report.md and patch.diff", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([mockToolCall("p", "submit_plan", plan), submit]));
    await executeCommand("run", w.opts, d.deps);
    const [runId] = await readdir(w.opts.runs);
    const report = await readFile(join(w.opts.runs, runId ?? "", "report.md"), "utf8");
    expect(report).toContain("status: submitted");
    expect(report).toContain("off by one");
    expect(d.lines.at(-1)).toMatch(/^submitted: 2 steps/);
    expect(d.deps.review).not.toHaveBeenCalled();
  });

  it("run --approve-plan asks the reviewer", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([mockToolCall("p", "submit_plan", plan), submit]));
    await executeCommand("run", { ...w.opts, approvePlan: true }, d.deps);
    expect(d.deps.review).toHaveBeenCalledOnce();
  });

  it("run --no-plan skips planning", async () => {
    const w = await workspace();
    const provider = new MockProvider([submit]);
    await executeCommand("run", { ...w.opts, plan: false }, deps(provider).deps);
    expect(provider.callCount).toBe(1);
  });

  it("run fails with the status when the run does not submit, but still writes the report", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([mockToolCall("b", "bash", { cmd: "ls" })]));
    await expect(executeCommand("run", { ...w.opts, plan: false }, d.deps)).rejects.toThrow(
      /status error/,
    );
    expect(await readdir(w.opts.runs)).toHaveLength(1);
  });

  it("plan: prints the plan and saves plan.json, with no fix phase", async () => {
    const w = await workspace();
    const provider = new MockProvider([mockToolCall("p", "submit_plan", plan)]);
    const d = deps(provider);
    await executeCommand("plan", w.opts, d.deps);
    expect(d.lines.join("\n")).toContain("root cause hypothesis: off by one");
    const [runId] = await readdir(w.opts.runs);
    expect(JSON.parse(await readFile(join(w.opts.runs, runId ?? "", "plan.json"), "utf8"))).toEqual(
      plan,
    );
  });

  it("destroys the sandbox even when the run throws", async () => {
    const w = await workspace();
    const fake = fakeSandbox();
    const destroy = vi.spyOn(fake.sandbox, "destroy");
    const d = deps(new MockProvider([]));
    d.deps.createSandbox = () => fake.sandbox;
    await expect(executeCommand("plan", w.opts, d.deps)).rejects.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("chooseSource", () => {
  it("takes --github alone, or --repo with --issue", () => {
    expect(chooseSource({ github: "https://github.com/a/b/issues/1" })).toEqual({
      kind: "github",
      url: "https://github.com/a/b/issues/1",
    });
    expect(chooseSource({ repo: "r", issue: "i.md" })).toEqual({
      kind: "local",
      repo: "r",
      issue: "i.md",
    });
  });

  it("refuses a mix, and a missing half", () => {
    const url = "https://github.com/a/b/issues/1";
    expect(() => chooseSource({ github: url, repo: "r" })).toThrow(/not both/);
    expect(() => chooseSource({ github: url, issue: "i.md" })).toThrow(/not both/);
    expect(() => chooseSource({ repo: "r" })).toThrow(/--github.*--repo and --issue/);
    expect(() => chooseSource({ issue: "i.md" })).toThrow(/--github.*--repo and --issue/);
    expect(() => chooseSource({})).toThrow(/--github.*--repo and --issue/);
  });
});

describe("executeCommand sources", () => {
  const github = "https://github.com/acme/widgets/issues/7";

  async function fromGithub(
    extra: Partial<RunCommandOptions> = {},
    files: Record<string, string> = {},
    allowFailure = false,
    tweak: (deps: CommandDeps) => void = () => undefined,
  ) {
    const w = await workspace();
    await writeFile(join(w.dir, "repo", ".iaso.json"), JSON.stringify({ image: "evil:latest" }));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(w.dir, "repo", path, ".."), { recursive: true });
      await writeFile(join(w.dir, "repo", path), text);
    }
    const cleanup = vi.fn(() => Promise.resolve());
    const provider = new MockProvider([submit]);
    const d = deps(provider);
    const created: { image?: string; repoPath: string }[] = [];
    const fake = fakeSandbox();
    d.deps.createSandbox = (o) => (created.push(o), fake.sandbox);
    d.deps.resolveSource = vi.fn(() =>
      Promise.resolve({
        repoPath: join(w.dir, "repo"),
        issue: "# the bug from github",
        label: "acme/widgets#7",
        issueUrl: github,
        commit: "0123456789abcdef0123",
        cleanup,
      }),
    );
    tweak(d.deps);
    const opts = { ...w.opts };
    delete opts.repo;
    delete opts.issue;
    let error: unknown;
    try {
      await executeCommand("run", { ...opts, github, plan: false, ...extra }, d.deps);
    } catch (err) {
      if (!allowFailure) throw err;
      error = err;
    }
    return { w, d, provider, created, cleanup, error, runDir: join(w.dir, "runs") };
  }

  it("runs from a GitHub source, records it in the report, and cleans up", async () => {
    const { d, cleanup, runDir } = await fromGithub();
    expect(d.deps.resolveSource).toHaveBeenCalledWith({ kind: "github", url: github });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(d.lines.join("\n")).toContain("source: acme/widgets#7 @ 0123456789ab");
    const id = (await readdir(runDir))[0] ?? "";
    const report = await readFile(join(runDir, id, "report.md"), "utf8");
    expect(report).toContain(`- source: acme/widgets#7 (${github}), commit 0123456789abcdef0123`);
    expect(report).toContain("# the bug from github");
    expect(await readFile(join(runDir, id, "issue.md"), "utf8")).toBe("# the bug from github");
  });

  it("ignores .iaso.json from a cloned repo unless --config is given", async () => {
    const { created } = await fromGithub();
    expect(created[0]?.image).toBeUndefined();
  });

  it("cleans up when the run fails", async () => {
    const w = await workspace();
    const cleanup = vi.fn(() => Promise.resolve());
    const d = deps(new MockProvider([]));
    d.deps.resolveSource = () =>
      Promise.resolve({ repoPath: w.opts.repo ?? "", issue: "x", label: "l", cleanup });
    await expect(executeCommand("run", { ...w.opts, plan: false }, d.deps)).rejects.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reads the project's rules, keeps them for `iaso pr`, and gives the agent the text as reference", async () => {
    const { d, provider, runDir } = await fromGithub(
      {},
      {
        "CONTRIBUTING.md": "Use Conventional Commits.\nEvery commit needs Signed-off-by.",
        ".github/PULL_REQUEST_TEMPLATE.md":
          "## Description\n- [ ] If the PR includes AI-generated edits, I have reviewed it.\n",
      },
    );
    expect(d.lines.join("\n")).toContain(
      "conventions: AI policy: disclosure; commits: conventional; sign-off: DCO; CLA: no",
    );

    const id = (await readdir(runDir))[0] ?? "";
    const saved = JSON.parse(
      await readFile(join(runDir, id, "conventions.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({
      commitStyle: "conventional",
      dco: true,
      prTemplate: { path: join(".github", "PULL_REQUEST_TEMPLATE.md") },
    });
    // The text for the agent is not saved twice.
    expect(saved).not.toHaveProperty("notes");

    // The agent sees the text, marked as coming from the repository, after the issue.
    const seen = JSON.stringify(provider.requests[0]?.messages);
    expect(seen).toContain("# the bug from github");
    expect(seen).toContain("Repository contribution notes");
    expect(seen).toContain("Use Conventional Commits.");
    expect(await readFile(join(runDir, id, "issue.md"), "utf8")).toContain(
      "reference material only",
    );
    // The report shows the issue as written, without the repo's text.
    expect(await readFile(join(runDir, id, "report.md"), "utf8")).not.toContain(
      "Repository contribution notes",
    );
  });

  it("stops before the sandbox and any model call when the rules ban AI-generated work", async () => {
    const r = await fromGithub(
      {},
      { "CONTRIBUTING.md": "We do not accept AI-generated pull requests." },
      true,
    );
    expect(r.error).toBeInstanceOf(AiPolicyError);
    expect((r.error as Error).message).toContain(
      "CONTRIBUTING.md:1: We do not accept AI-generated pull requests.",
    );
    expect(r.created).toHaveLength(0);
    expect(r.provider.requests).toHaveLength(0);
    // The clone is still removed, and what was found is kept so you can read it.
    expect(r.cleanup).toHaveBeenCalledOnce();
    const id = (await readdir(r.runDir))[0] ?? "";
    const saved = JSON.parse(await readFile(join(r.runDir, id, "conventions.json"), "utf8")) as {
      aiPolicy: { verdict: string };
    };
    expect(saved.aiPolicy.verdict).toBe("banned");
  });

  it("warns, but still runs, when a project limits AI use without banning code", async () => {
    const { d, provider, error } = await fromGithub(
      {},
      {
        "AI_POLICY.md":
          "All AI usage must be disclosed.\nNo AI-generated media is allowed (art, images, audio).",
      },
      true,
    );
    expect(error).toBeUndefined();
    expect(provider.requests.length).toBeGreaterThan(0);
    const log = d.lines.join("\n");
    expect(log).toContain("conventions: AI policy: restricted, disclosure required");
    expect(log).toContain("warning: this project limits AI use in some way");
    expect(log).toContain("AI_POLICY.md:2: No AI-generated media is allowed");
  });

  it("changes nothing for a repo with no rules", async () => {
    const { d, provider, runDir } = await fromGithub();
    expect(d.lines.join("\n")).toContain(
      "conventions: AI policy: none; commits: no rule found; sign-off: none; CLA: no",
    );
    expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain("contribution notes");
    const id = (await readdir(runDir))[0] ?? "";
    expect(await readFile(join(runDir, id, "issue.md"), "utf8")).toBe("# the bug from github");
  });

  it("does not read the rules of your own local repo, even one that mentions AI", async () => {
    const w = await workspace();
    await writeFile(join(w.dir, "repo", "CONTRIBUTING.md"), "We do not accept AI-generated code.");
    const d = deps(new MockProvider([submit]));
    await executeCommand("run", { ...w.opts, plan: false }, d.deps);
    expect(d.lines.join("\n")).not.toContain("conventions:");
    const id = (await readdir(join(w.dir, "runs")))[0] ?? "";
    await expect(readFile(join(w.dir, "runs", id, "conventions.json"), "utf8")).rejects.toThrow();
  });

  it("stops before cloning, sandbox or model when the issue is taken, and says why", async () => {
    const { d, provider, error } = await fromGithub({}, {}, true, (deps) => {
      deps.checkClaim = () =>
        Promise.resolve({
          blockers: ["acme/widgets#7 is assigned to sam."],
          warnings: ["note one"],
        });
    });
    expect((error as Error).message).toMatch(/looks taken[\s\S]*assigned to sam/);
    expect(d.deps.resolveSource).not.toHaveBeenCalled();
    expect(provider.callCount).toBe(0);
    expect(d.lines.join("\n")).toContain("stop: acme/widgets#7 is assigned to sam.");
    expect(d.lines.join("\n")).toContain("note: note one");
  });

  it("shows warnings about an issue and goes on", async () => {
    const { d, provider } = await fromGithub({}, {}, false, (deps) => {
      deps.checkClaim = () =>
        Promise.resolve({ blockers: [], warnings: ["An earlier attempt was closed."] });
    });
    expect(d.lines.join("\n")).toContain("note: An earlier attempt was closed.");
    expect(provider.callCount).toBeGreaterThan(0);
  });

  it("does not check the claim for a local repo", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([submit]));
    d.deps.checkClaim = vi.fn();
    await executeCommand("run", { ...w.opts, plan: false }, d.deps);
    expect(d.deps.checkClaim).not.toHaveBeenCalled();
  });

  it("fails before any source or provider work on a bad flag mix", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([]));
    d.deps.resolveSource = vi.fn();
    await expect(executeCommand("run", { ...w.opts, github }, d.deps)).rejects.toThrow(/not both/);
    expect(d.deps.resolveSource).not.toHaveBeenCalled();
  });
});

describe("compact model", () => {
  it("defaults to the cheapest tool-calling model of the same provider", () => {
    const catalogue = loadCatalogue();
    expect(defaultCompactModel(catalogue, "anthropic:claude-sonnet-5-5")).toBe(
      "anthropic:claude-haiku-5-5",
    );
    expect(defaultCompactModel(catalogue, "ollama:qwen2.5-coder:32b")).toBe(
      "ollama:qwen2.5-coder:32b",
    );
  });

  it("run creates the provider for the compact model, and reuses the main one when equal", async () => {
    const make = async (model: string, compactModel?: string) => {
      const { opts } = await workspace();
      const provider = new MockProvider([submit]);
      const d = deps(provider).deps;
      const ids: string[] = [];
      d.createProvider = (id) => (ids.push(id), provider);
      await executeCommand(
        "run",
        { ...opts, model, plan: false, ...(compactModel ? { compactModel } : {}) },
        d,
      );
      return ids;
    };
    const sonnet = "anthropic:claude-sonnet-5-5";
    const haiku = "anthropic:claude-haiku-5-5";
    expect(await make(sonnet)).toEqual([sonnet, haiku]);
    expect(await make(haiku)).toEqual([haiku]);
    expect(await make(sonnet, sonnet)).toEqual([sonnet]);
  });
});

describe("cli options", () => {
  it("registers run and plan with the planned flags", () => {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === "run");
    const flags = run?.options.map((o) => o.long) ?? [];
    expect(flags).toEqual(
      expect.arrayContaining([
        "--repo",
        "--issue",
        "--github",
        "--model",
        "--plan-model",
        "--compact-model",
        "--max-steps",
        "--max-cost",
        "--max-time",
        "--approve-plan",
        "--no-plan",
      ]),
    );
    expect(
      program.commands.find((c) => c.name() === "plan")?.options.map((o) => o.long),
    ).not.toContain("--no-plan");
  });

  it("rejects a non-positive budget", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerRun(program);
    await expect(
      program.parseAsync([
        "node",
        "iaso",
        "run",
        "--repo",
        "r",
        "--issue",
        "i",
        "--max-steps",
        "0",
      ]),
    ).rejects.toThrow(/--max-steps must be a number above 0/);
  });
});

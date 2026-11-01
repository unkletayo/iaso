import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CommandDeps, executeCommand } from "../../src/commands/run.js";
import { MockProvider, mockToolCall } from "../../src/providers/mock.js";
import { DockerSandbox } from "../../src/sandbox/docker.js";
import { githubSource } from "../../src/sources/github.js";
import type { Source } from "../../src/sources/types.js";
import { FIXTURE_DIR } from "../helpers/fixture-run.js";

/**
 * `iaso run --github <issue url>` end to end with a scripted model: the issue comes from a fake
 * GitHub API, the repo is cloned from a local git origin, the fix runs in a real sandbox. Free and
 * offline. Opt in with: IASO_DOCKER=1 npx vitest run test/integration/source
 */
const enabled = process.env.IASO_DOCKER === "1";
const MODEL = "anthropic:claude-haiku-5-5";
const ISSUE_URL = "https://github.com/acme/widgets/issues/7";

const calls = [
  mockToolCall("c1", "bash", { cmd: "cat src/range.js" }),
  mockToolCall("c2", "edit_file", {
    path: "src/range.js",
    oldText: "i < end;",
    newText: "i <= end;",
  }),
  mockToolCall("c3", "bash", { cmd: "node --test 2>&1 | grep -E '^# (pass|fail)'" }),
  mockToolCall("c4", "submit", {
    summary: "sumRange stopped before `end`. Loop now uses <=.",
    prTitle: "Include the end value in sumRange",
    prSummary: "sumRange stopped before end. The loop now uses <=.",
    assumptions: [],
    testsAdded: [],
    confidence: "high",
  }),
];

/** The fixture as a one-commit git repo, to clone from. */
async function originRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iaso-origin-"));
  await cp(FIXTURE_DIR, dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

const fakeGithub = ((input: string | URL | Request): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.endsWith("/issues/7")) throw new Error(`unexpected request: ${url}`);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        title: "sumRange skips the last value",
        state: "open",
        body: "sumRange(1, 5) returns 10. It should return 15, because both ends are included.",
        html_url: ISSUE_URL,
        user: { login: "reporter" },
        comments: 0,
        labels: [],
      }),
      { status: 200 },
    ),
  );
}) as typeof fetch;

describe.skipIf(!enabled)(
  "run --github end to end (real Docker, scripted model, local origin)",
  () => {
    it(
      "clones the repo, fixes it in the sandbox, reports the source and cleans up",
      {
        timeout: 10 * 60_000,
      },
      async () => {
        const origin = await originRepo();
        const runs = await mkdtemp(join(tmpdir(), "iaso-runs-"));
        const provider = new MockProvider(calls, MODEL);
        const sources: Source[] = [];
        const log: string[] = [];
        const deps: CommandDeps = {
          checkClaim: () => Promise.resolve({ blockers: [], warnings: [] }),
          resolveSource: async (choice) => {
            if (choice.kind !== "github") throw new Error("expected a github source");
            const src = await githubSource(choice.url, {
              fetch: fakeGithub,
              cloneUrl: () => `file://${origin}`,
            });
            sources.push(src);
            return src;
          },
          createProvider: () => provider,
          createSandbox: ({ runId, repoPath, image }) =>
            new DockerSandbox({ runId, repoPath, ...(image === undefined ? {} : { image }) }),
          review: () => Promise.reject(new Error("no review expected")),
          log: (line) => log.push(line),
        };

        await executeCommand(
          "run",
          {
            github: ISSUE_URL,
            model: MODEL,
            plan: false,
            maxSteps: 20,
            maxCost: 0.5,
            maxTime: 10,
            runs,
          },
          deps,
        );

        const [runId] = await readdir(runs);
        expect(runId).toBeDefined();
        const runDir = join(runs, runId ?? "");
        const report = await readFile(join(runDir, "report.md"), "utf8");
        expect(report).toContain("acme/widgets#7");
        expect(report).toContain(ISSUE_URL);
        expect(report).toMatch(/commit [0-9a-f]{40}/);
        expect(await readFile(join(runDir, "patch.diff"), "utf8")).toContain("i <= end");
        expect(log.join("\n")).toMatch(/source: acme\/widgets#7 @ [0-9a-f]{12}/);

        // The clone was only a staging copy: it is gone, and the origin is untouched.
        expect(sources).toHaveLength(1);
        expect(existsSync(sources[0]?.repoPath ?? "")).toBe(false);
        expect(await readFile(join(origin, "src", "range.js"), "utf8")).toContain("i < end;");
      },
    );
  },
);

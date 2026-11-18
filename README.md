# Iaso

<!-- LIVING-DOC: update this file whenever the application's behaviour, commands, flow, or configuration change. Do not let it describe what was planned — only what works now. -->

Iaso (Ἰασώ) is the Greek goddess of recovery and healing. This agent brings broken code back to health.

Iaso is a command-line coding agent that takes a bug report and a repository, reproduces the bug with a failing test, applies a minimal fix, verifies the tests pass, and outputs a patch. You review the patch and open the PR. Iaso never pushes code on its own.

**Status:** active development. `iaso models`, `iaso plan`, `iaso run`, `iaso serve`, `iaso replay`, `iaso find`, `iaso pr` and `iaso bench` all work, from a local repo or a GitHub issue URL.

One real benchmark result: **7 of 10 SWE-bench Lite tasks resolved** (95% CI 40%–89%), graded by the official harness, at a mean of **\$0.10 per task** using Claude Haiku.

---

## What it does

You give it a GitHub issue URL:

```sh
iaso run --github https://github.com/owner/repo/issues/123 \
         --model anthropic:claude-haiku-5-5
```

Before spending anything, Iaso checks that nobody else is already working on the issue: it stops if the issue is closed, locked, or assigned, and if an open pull request already says it closes the issue. There's no flag that overrides a stop.

Then it reads the project's contribution rules — `CONTRIBUTING`, the PR template, any AI policy, `AGENTS.md` — and writes them to `runs/<id>/conventions.json`. If the project appears to forbid AI-generated contributions, it stops and quotes the lines. That stop is deliberate; there's no override.

If the rules pass, it spins up a Docker sandbox, runs the agent loop, and writes three files:

- `patch.diff` — the fix
- `report.md` — what it did, the plan, every test run, cost, step count
- `run.json` — structured metadata for `iaso pr`

Before writing them, Iaso checks a submitted patch itself instead of taking the agent's word. It re-runs the agent's passing test command with the fix (it must pass) and on the original code with only the new test files kept (it must fail), and runs `testCommand` from `.iaso.json` when one is set. The result (`verified`, `failed` or `not_checked`, each with its reason) goes into `report.md` and `run.json`. A failed check is only reported, never retried, and it puts a `[TODO]` marker in the `iaso pr` draft. The patch's added lines are also scanned for things that look like secrets (API keys, tokens, private keys, `password = "…"`); a finding is named by kind, file and line, never quoted, and also puts a `[TODO]` marker in the draft.

You apply the patch, run the tests yourself, and open the PR if it looks good.

---

## How the agent works

The loop runs in four phases: **plan → reproduce → fix → verify**.

Planning is a separate model call with read-only bash access. The agent reads the codebase, writes a structured plan (steps, files to change, risks), and either submits it automatically or waits for your approval (`--approve-plan`). The fix loop then runs against that pinned plan.

Each step, the agent can call `bash`, `read_file`, `edit_file`, `notes` (to record facts, test results, and failed approaches), and `submit` (to end the run). Token usage is tracked per step. When the context window fills up, a cheaper model compacts older steps into a rolling summary with a fixed schema: `learned`, `files`, `tests`, `failedApproaches` — no information is ever discarded silently.

If the agent repeats the same bash command or the same edit three times, it's nudged. At five identical repetitions, the run ends as `stuck`. Cost, step count, and time each have hard limits; the defaults are \$1, 50 steps, and 20 minutes. The time limit also holds inside a step: a command's timeout is cut to the time left, and a model call (retries included) is cancelled when the time runs out.

A run writes one trajectory step per line to `trajectory.jsonl` as it goes, so a crash doesn't lose earlier work, and `iaso replay` can reconstruct exactly what the model saw at any step.

---

## Try it

Requires Node 22+ and Docker (for `iaso run`).

```sh
npm install
npx tsx src/cli.ts --help
npx tsx src/cli.ts models        # list models + which API keys are set
```

API keys come from environment variables only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`. Copy `.env.example` for the full list. Iaso does not load `.env` files.

For Docker Desktop on Mac, point it at the socket first:

```sh
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
```

---

## Run it on a bug

```sh
# From a GitHub issue
iaso run --github https://github.com/owner/repo/issues/123 \
         --model anthropic:claude-haiku-5-5

# From a local repo and a bug report file
iaso run --repo ./my-project --issue ./bug.md
```

Each run writes to `./runs/<runId>/`. Apply the patch to a fresh clone at the commit named in `report.md`:

```sh
git apply runs/<runId>/patch.diff
```

Iaso never pushes, opens a PR, or comments on the issue. You review the patch and do that yourself.

A run stops at its limits: `--max-steps` (default 50), `--max-cost` (default \$1), `--max-time` (default 20 minutes). `--effort <low|medium|high|xhigh|max>` sets how hard the model thinks in the plan and fix phases; without it the model's own default applies. Models that take no such setting (see `effort` in `models.json`) ignore it with a note.

`--attempts <n>` makes up to `n` attempts at the fix, each in a fresh sandbox, all within the same cost and time limits. The plan is made once. The run stops at the first attempt whose patch passes Iaso's own check, and otherwise keeps the attempt with the best check result; `report.md` lists them all, and each attempt's files are in `runs/<id>/attempt-<n>/`. Real repos with slow test suites may need more:

```sh
iaso run --github <url> --max-cost 2 --max-time 40
```

`GITHUB_TOKEN` is optional. Without one, GitHub allows 60 API calls an hour; with one (read-only fine-grained token), you get 5,000. The token stays on your machine and is never passed into the sandbox or stored in the clone.

---

## Find open-source issues to fix

`iaso find` searches GitHub for open, unassigned `good first issue` bugs in projects that actively merge outside contributions.

```sh
iaso find --language typescript
iaso find --label bug --label "help wanted" --bugs-only
```

It searches repositories first (stars, licence, activity), then fetches open issues only for projects worth measuring, to stay inside GitHub's rate limits. Each issue gets a score out of 100 with the reasons: activity (30 pts), outside merge rate (20 pts), bug label (20 pts), freshness (10 pts), comment count (10 pts), stars (10 pts). Features score 10 lower. Data-entry chores (`hacktoberfest`, "Add new ...") are dropped entirely.

It then runs the same claim check as `iaso run`: any issue with an open PR that says it closes it is dropped from the list. `--show-skipped` shows what was cut and why.

Without a `GITHUB_TOKEN`, GitHub caps at 60 calls an hour and Iaso measures 6 projects; with one, it measures 10. Searches are paced (about 6.5 s apart without a token, 3 s with one) because GitHub rejects bursts, and if it still rate-limits, Iaso waits however long GitHub asks and retries that search once.

---

## Stream a run over stdio

`iaso serve --stdio` runs the agent and streams every event as a JSON line to stdout. Stdin accepts JSON control messages (`approve`, `reject`, `cancel`). This is the integration point for UIs and other callers that want a live feed.

```sh
# Start a run and stream events
iaso serve --stdio \
           --repo ./my-project --issue ./bug.md \
           --model anthropic:claude-haiku-5-5

# Each output line is one JSON object, e.g.:
# {"type":"run.created","run_id":"20241118T123456-ab12","status":"created"}
# {"type":"run.in-progress","run_id":"...","status":"in-progress"}
# {"type":"message.part","run_id":"...","part":{"kind":"tool_call",...}}
# {"type":"run.awaiting","run_id":"...","status":"awaiting","await":{...}}
# {"type":"run.completed","run_id":"...","status":"completed","result":{...}}
```

Event types:

| Type              | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `run.created`     | Run ID assigned, source ready                                           |
| `run.in-progress` | First step started                                                      |
| `message.part`    | A streaming piece: text delta, tool call, tool result, or context event |
| `run.awaiting`    | A tool needs approval before it can run                                 |
| `run.completed`   | Agent submitted; `result` holds the full `PipelineResult`               |
| `run.failed`      | Run ended without submitting                                            |
| `run.cancelled`   | Cancelled via a `cancel` control message                                |

Control messages (write to stdin, one JSON per line):

```json
{"kind": "approve", "id": "<tool-call-id>"}
{"kind": "reject",  "id": "<tool-call-id>", "reason": "optional"}
{"kind": "cancel"}
```

Every tool call produces a `run.awaiting` event before running, so callers gate each one. Progress messages (source, sandbox status) go to stderr so stdout stays JSON-only.

---

## Open a pull request

After a successful run:

```sh
iaso pr <runId>          # shows the diff, what the project asks of you, and a draft PR title + body
iaso pr <runId> --push   # forks, pushes, and opens a draft PR (requires gh logged in)
```

`iaso pr` on its own changes nothing. It shows:

- File list with +/- counts
- Full diff
- Project requirements (CLA, DCO sign-off, changelog, AI policy excerpts)
- A draft title and body, saved to `runs/<id>/pr-draft.md`

The draft always has `[TODO]` markers for anything only you can say: that you reviewed the patch, that you ran the tests, that an AI helped. No template checkbox is ticked. `iaso pr --push` refuses to continue while any `[TODO]` remains.

When you do run `--push`, it asks you to type `owner/repo` before touching anything. It won't open more than 2 PRs to the same repo in 24 hours. The PR is always opened as a draft; you mark it ready yourself.

---

## Replay a run

```sh
iaso replay <runId>                # print the full trajectory
iaso replay <runId> --context 12   # print what the model saw at step 12
```

---

## Benchmark

`iaso bench` runs a seeded sample of SWE-bench Lite in Docker using the official per-instance images, grades with the official harness, and writes `predictions.jsonl` and `results.md`. `--sample` is required (no default, because it costs money). `--attempts <n>` gives each task up to `n` attempts within its cost cap, keeping the first whose patch passes Iaso's own check; `tasks.jsonl` records the check and the attempts, and the cost of all of them.

```sh
iaso bench --sample 10 --seed 42 \
           --model anthropic:claude-haiku-5-5 \
           --max-cost 1
```

One real run of that command on this codebase: **7 of 10 resolved (95% CI 40%–89%)**, \$1.02 total, mean \$0.10 per task. Ten tasks is a small sample, so the interval is wide; this doesn't meet or miss the spec target of 80% on 50 tasks. The three failures all applied a correct patch; the hidden tests asserted behaviour the issue text never mentioned.

The first run creates a Python venv at `~/.iaso/swebench-venv` and pins the harness there (needs Python 3.10+). Instance images are roughly 1 GB each and are removed after each task unless you pass `--keep-images`. Run one task at a time on a laptop; each sandbox can use 4 GB.

A crashed run continues with `--resume`. The folder name encodes the options (`runs/bench-swebench-lite-<model>-seed42-n10`), so the same command finds the right folder automatically. `--max-total-cost <usd>` caps the whole bench run; `--resume` can't go past it.

---

## Project config

A repo can carry a `.iaso.json`:

```json
{
  "image": "node:22-bookworm",
  "installCommand": "npm ci",
  "testCommand": "npm test",
  "relatedTestsPattern": "test/{name}.test.ts",
  "extraRules": ["Always run tests before submitting."],
  "services": []
}
```

With an `installCommand`, Iaso runs it in the sandbox before any model call, then turns the sandbox's network off for the rest of the run, so code in the repo or text planted in the issue can't send anything out; the model is told the network is off. Without one, the agent may need to install things itself, so the network stays on, and `report.md` says which happened. A failed install stops the run before anything is spent on the model.

Pass it with `--config`. For local repos, it's loaded automatically; for cloned repos, it's ignored unless you pass `--config` (a project's config can influence the Docker image and prompt, so it isn't trusted without an explicit opt-in).

---

## Layout

```
src/
  cli.ts           entry point (commander)
  config.ts        .iaso.json schema and defaults
  models.ts        model catalogue loader (reads models.json)
  commands/        run/plan, serve, replay, bench, find, pr, models
  core/            session API — event streaming + approval control (used by serve)
  agent/           loop, plan phase, pipeline, attempts, prompts, report, budget, verify, secrets
  context/         token budget, shaping, staleness, loop detection, compaction, state/notes
  providers/       Anthropic, OpenAI-compatible, mock, registry, retry
  sandbox/         Docker sandbox, images, prebuilt SWE-bench images, worktree sandbox
  sources/         local repo, GitHub issue, SWE-bench loader
  tools/           bash, read_file, edit_file, notes, submit, submit_plan, read_output
  telemetry/       cost tracking and trajectory logging
  bench/           benchmark runner, harness call, results
  oss/             contribution rules, AI-policy reading, claim check, publisher
test/              unit tests + opt-in integration, live and net tests
models.json        model catalogue (prices, context windows, provider keys)
INTERNALS.md       full contributor guide: module map, data flow, key abstractions
```

---

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Two test groups are off by default:

```sh
# Real Docker (needs a running daemon; first run pulls ~1 GB image)
IASO_DOCKER=1 npx vitest run test/integration

# Real model API (costs a few cents; needs ANTHROPIC_API_KEY)
IASO_LIVE=1 npx vitest run test/live

# GitHub (reads one public issue and clones its repo)
IASO_NET=1 npx vitest run test/net
```

Progress and the full build plan: `PROGRESS.md`.

---

## Design decisions worth knowing

**The agent never pushes code.** `iaso pr --push` exists and works, but it asks you to type `owner/repo` by hand before touching GitHub. There's no flag that skips this.

**AI-ban stops are hard.** If a project's contribution rules appear to ban AI-generated code, the run stops before any model call or sandbox is started. No override flag. The check is keyword matching on single lines, so it can miss rules written in unusual ways; reading the project's rules yourself is still necessary.

**Token budget is explicit.** Every model call has a cost; every cost check runs before the next step. The compactor (a cheaper model that summarises old steps) has its own cost tracked separately. When a run ends on budget, the diff it had so far is still written to disk.

**Context compaction keeps `failedApproaches`.** The compaction schema has a `failedApproaches` field that is never dropped. If the agent tried something and it didn't work, that fact survives every compaction round so the agent doesn't loop back to the same dead end.

**Trajectory is append-only.** Each step appends one JSON line to `trajectory.jsonl` immediately after the model call returns. A crash, OOM, or Docker timeout loses at most one step; everything before it is on disk and replayable.

---

## What's next

- Session API (`iaso serve --stdio`) is complete; a React web UI is planned next
- Gemini provider (M8)
- Podman + unsafe local mode without Docker (M9)
- Larger benchmark run (50 tasks)

---

License: MIT

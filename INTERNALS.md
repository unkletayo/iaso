# Iaso — Internal Documentation

> For contributors and maintainers. Everything a new team member needs to understand how the system is built, what every file does, and how the parts fit together.

---

## Table of contents

1. [System overview](#system-overview)
2. [Data flow: a full run](#data-flow-a-full-run)
3. [Module map](#module-map)
4. [Key abstractions](#key-abstractions)
5. [The agent loop in detail](#the-agent-loop-in-detail)
6. [Context window management](#context-window-management)
7. [How the Session API works](#how-the-session-api-works)
8. [Outputs written per run](#outputs-written-per-run)
9. [Adding a new command](#adding-a-new-command)
10. [Adding a new provider](#adding-a-new-provider)
11. [Testing strategy](#testing-strategy)

---

## System overview

Iaso is a CLI coding agent. Given a bug report (issue) and a repository, it:

1. Checks whether the issue is already claimed or the project bans AI contributions.
2. Optionally runs a **plan phase**: a read-only loop that produces a structured plan.
3. Runs the **fix loop**: understand → reproduce → fix → verify → submit.
4. After the agent submits, Iaso runs its own **post-run check** to verify the patch independently.
5. Writes `patch.diff`, `report.md`, and `run.json` to `runs/<runId>/`.

Everything that touches code runs inside a Docker sandbox. The network is cut after the install step. The agent never pushes to GitHub.

```
CLI ──► commands/ ──► agent/pipeline.ts ──► agent/loop.ts ──► providers/
                           │                      │
                        sandbox/              tools/  context/
                           │
                       sources/
```

---

## Data flow: a full run

```
iaso run --github <url>
  │
  ▼
commands/run.ts :: executeCommand()
  │  loads catalogue, resolves model, picks run ID, creates runDir
  │
  ├─► sources/github.ts :: githubSource()
  │     clone repo, fetch issue text ──► Source { repoPath, issue, cleanup }
  │
  ├─► oss/conventions.ts :: readConventions()
  │     scan CONTRIBUTING, PR template, AI policy ──► Conventions
  │     [stop if aiPolicy.verdict === "banned"]
  │
  ├─► agent/attempts.ts :: runAttempts()
  │   │  (loops 1..N, stopping when a patch is verified)
  │   │
  │   ├─► sandbox/docker.ts :: DockerSandbox.start()
  │   │     pull image, create container, copy /repo in, tag baseline commit
  │   │
  │   ├─► sandbox/install.ts :: installThenCutNetwork()
  │   │     run installCommand, then sandbox.setNetwork(false)
  │   │
  │   ├─► agent/pipeline.ts :: runPipeline()
  │   │   │
  │   │   ├─── [plan phase] agent/plan.ts :: runPlan()
  │   │   │      agent/loop.ts with read-only tools + submit_plan
  │   │   │      → Plan { filesToChange, testPlan, steps, risks, rootCauseHypothesis }
  │   │   │
  │   │   └─── [fix phase] agent/loop.ts :: runLoop()
  │   │          step 1..N:
  │   │            context/layers.ts :: buildRequest()   → ChatRequest
  │   │            providers/<x>.ts  :: provider.chat()  → ChatResponse
  │   │            tools/<x>.ts      :: runTool()        → output string
  │   │            context/loops.ts  :: LoopDetector     → nudge / end
  │   │            telemetry/trajectory.ts               → append JSONL line
  │   │          ends when: submit called, budget exceeded, stuck, or error
  │   │
  │   └─► agent/verify.ts :: verifyRun()
  │         re-run agent's test with fix (must pass)
  │         re-run agent's test without fix (must fail)
  │         optionally run testCommand from .iaso.json
  │
  └─► agent/report.ts :: writeReport()
        report.md, patch.diff, run.json ──► runs/<runId>/
```

---

## Module map

Each entry: **file → what it does → what it depends on / is depended on by**.

### Entry point

| File         | Purpose                                                              | Key relations               |
| ------------ | -------------------------------------------------------------------- | --------------------------- |
| `src/cli.ts` | Builds the Commander program, registers all commands, calls `main()` | Imports all `commands/*.ts` |

### `src/commands/`

The CLI commands. Each `register*()` function attaches a subcommand to the Commander program, parses options, and calls the core logic.

| File        | Purpose                                                                                                                                                                                                                    | Key relations                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `run.ts`    | `iaso run` and `iaso plan`. Resolves source, creates sandbox, calls `runAttempts()` or `runPlanPhase()`. Also exports shared helpers (`chooseSource`, `setupFor`, `defaultCompactModel`, `newRunId`) reused by `serve.ts`. | `agent/attempts`, `agent/pipeline`, `sandbox/docker`, `sources/*`, `oss/*` |
| `serve.ts`  | `iaso serve --stdio`. Streams JSON-lines over stdin/stdout. Wraps `createSession()`. Translates `SessionEvent` → `ServeEvent`. Reads `ServeControl` from stdin.                                                            | `core/session`, `commands/run` (shared helpers)                            |
| `bench.ts`  | `iaso bench`. Runs multiple SWE-bench instances.                                                                                                                                                                           | `bench/runner`, `bench/harness`                                            |
| `replay.ts` | `iaso replay`. Reads `trajectory.jsonl`, pretty-prints steps or reconstructs the model's context at a given step.                                                                                                          | `telemetry/trajectory`, `context/layers`                                   |
| `pr.ts`     | `iaso pr`. Reads `run.json`, shows diff, project conventions, draft PR. `--push` forks, pushes, opens draft PR via `gh`.                                                                                                   | `oss/publish`, `oss/conventions`, `agent/report`                           |
| `find.ts`   | `iaso find`. Scores GitHub issues using activity, merge rate, label weights.                                                                                                                                               | `oss/find`, `oss/claim`                                                    |
| `models.ts` | `iaso models`. Prints the model catalogue and which API keys are set.                                                                                                                                                      | `src/models`                                                               |

### `src/agent/`

The agent's core logic.

| File          | Purpose                                                                                                                                                                                          | Key relations                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pipeline.ts` | Top-level orchestrator. `runPipeline()` calls `runPlanPhase()` then `runLoop()`. Manages the per-phase budget. Writes `issue.md` and `plan.json`.                                                | `loop`, `plan`, `prompts`, `budget`, `tools/*`, `telemetry/trajectory`         |
| `loop.ts`     | The agentic loop. `runLoop()` drives `runStep()` until done. Each step: build request → call model → run tools → check for loops/budget → log trajectory. Manages context compaction.            | `context/*`, `providers/types`, `sandbox/types`, `tools/schema`, `telemetry/*` |
| `plan.ts`     | Plan-phase loop. Identical to the fix loop but restricted to read-only tools + `submit_plan`. `renderPlan()` formats a `Plan` for display/injection.                                             | `loop`, `context/state`                                                        |
| `attempts.ts` | Multi-attempt orchestration. `runAttempts()` runs the pipeline up to N times in fresh sandboxes, sharing the budget, and picks the best patch. Plan is shared after the first attempt makes one. | `pipeline`, `verify`, `sandbox/install`                                        |
| `prompts.ts`  | System prompt text, nudge messages, constants. `buildSystemPrompt()` assembles the base prompt + per-repo extra rules. `PROMPT_VERSION` is logged on every trajectory line.                      | (pure text, no imports)                                                        |
| `verify.ts`   | Post-run patch verification. `verifyRun()` runs the agent's test with and without the fix, then `testCommand` if set. `testFilesOf()` identifies which changed files are tests.                  | `sandbox/types`, `sandbox/docker` (for BASELINE\_TAG), `context/state`         |
| `report.ts`   | `writeReport()` writes `report.md`, `patch.diff`, `run.json`. `renderReport()` formats prose. `runInfoOf()` extracts structured data for `run.json`.                                             | `pipeline`, `verify`, `sandbox/install`, `secrets`                             |
| `budget.ts`   | `Budget` class. Checks steps, cost (USD), and time against limits. Returns a human-readable description when a limit is exceeded.                                                                | `config` (BudgetLimits)                                                        |
| `secrets.ts`  | `scanDiff()` checks the patch for things that look like secrets (API keys, tokens, passwords). Never quotes the value; records kind, file, line.                                                 | (regex matching, no heavy deps)                                                |

### `src/core/`

| File         | Purpose                                                                                                                                                                                                                                                                                                               | Key relations                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `session.ts` | `createSession()` wraps `runPipeline()` and exposes events as an `AsyncIterable<SessionEvent>` and a `send()` control channel. Used by `iaso serve`. Implements `PushQueue` (a backpressure-safe async queue). `ApprovalPolicy` rules decide whether each tool call runs automatically, is asked about, or is denied. | `agent/pipeline`, `agent/loop` (LoopHooks) |

### `src/context/`

Context window management. The loop delegates context decisions entirely to this layer.

| File            | Purpose                                                                                                                                                                                                                      | Key relations                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `state.ts`      | `TaskState` and `RunState` types. `mergeTaskState()` applies a patch from the `notes` tool. `Plan` and `Submission` schemas.                                                                                                 | (Zod schemas, no runtime deps outside) |
| `layers.ts`     | `buildRequest()` assembles the `ChatRequest` from: system prompt, issue, optional plan, compacted summary, task state (notes), working-set files, and message history. Decides which messages are marked for prompt caching. | `providers/types`, `context/state`     |
| `budget.ts`     | `ContextMeter` measures request size in tokens (by counting chars / 4). `thresholdsFor()` computes the 50 % compact-at and 85 % hard-limit thresholds for a given context window.                                            | (no heavy deps)                        |
| `compaction.ts` | `compactSteps()` calls a cheap model to summarise old steps into a fixed schema. `splitSteps()` partitions the history into old and recent.                                                                                  | `providers/types`, `context/state`     |
| `loops.ts`      | `LoopDetector` tracks tool calls and flags repetitions. When the same call (name + input + output) appears three times, it's a "repeat".                                                                                     | (no heavy deps)                        |
| `shaping.ts`    | `shapeOutput()` strips ANSI codes, trims whitespace, collapses blank lines from bash output. `classifyCommand()` distinguishes `git`, `test`, `install`, and `other` commands so each gets the right shaping rules.          | (string processing, no heavy deps)     |
| `staleness.ts`  | `isStalePage()` detects when a working-set file shown to the model no longer matches the sandbox (e.g. it was edited). Used by `buildRequest()` to decide whether to include a file.                                         | `context/layers`                       |

### `src/providers/`

Model provider adapters. The `ModelProvider` interface (`types.ts`) is the only thing the agent layer sees.

| File                   | Purpose                                                                                                                                                      | Key relations                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `types.ts`             | `ModelProvider` interface. `ChatRequest`, `ChatResponse`, `Message`, `ContentBlock`, `ToolDef`, `Effort`, `Usage` types.                                     | (no deps — this is the boundary)                               |
| `anthropic.ts`         | Anthropic adapter. Maps `ChatRequest` → Anthropic SDK params. Handles prompt caching (`cacheBreakpoint`), streaming, and reasoning effort (`budget_tokens`). | `@anthropic-ai/sdk`, `providers/types`, `providers/retry`      |
| `openai-compatible.ts` | OpenAI-compatible adapter. Covers OpenAI, OpenRouter, Ollama. Maps effort levels to `reasoning_effort`.                                                      | `openai`, `providers/types`, `providers/retry`                 |
| `registry.ts`          | `createProvider()`: given a `provider:model` id, instantiates the right adapter with the API key from the environment.                                       | `models`, `providers/anthropic`, `providers/openai-compatible` |
| `retry.ts`             | `withRetry()` wraps a provider call, retrying on transient errors (rate limits, network blips) with exponential back-off.                                    | `providers/types`                                              |
| `mock.ts`              | Deterministic fake provider for unit tests. Returns scripted responses.                                                                                      | `providers/types`                                              |

### `src/sandbox/`

Docker execution environment.

| File          | Purpose                                                                                                                                                                                                                                   | Key relations                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `types.ts`    | `Sandbox` interface: `start`, `exec`, `readFile`, `writeFile`, `diff`, `setNetwork`, `destroy`.                                                                                                                                           | (no deps — boundary)                                                   |
| `docker.ts`   | `DockerSandbox` implements `Sandbox` via Docker. On `start()`: pulls image, creates container, copies `/repo` in, tags `iaso-baseline`. `diff()` compares against that tag. `DockerApi` interface lets tests swap the real Docker client. | `sandbox/images`, `sandbox/cleanup`, `sandbox/prebuilt`, `sandbox/tar` |
| `images.ts`   | Container naming, default image (`python:3.12-bookworm`), resource limits (CPU, memory, pids), user and directory constants.                                                                                                              | (no heavy deps)                                                        |
| `prebuilt.ts` | SWE-bench prebuilt image helpers. `instanceImage()` maps an instance id to its Docker image tag. `setupScript()` generates the in-container setup script for SWE-bench repos.                                                             | `sandbox/types`                                                        |
| `install.ts`  | `installThenCutNetwork()`: runs `installCommand` inside the sandbox, then calls `setNetwork(false)`. Returns `NetworkState` (`on` / `off`). `OFFLINE_RULE` is the extra prompt rule added when the network is cut.                        | `sandbox/types`                                                        |
| `cleanup.ts`  | `registerForCleanup()` / `installSignalHandlers()`: tracks live containers and removes them on SIGINT/SIGTERM.                                                                                                                            | (Node.js signals)                                                      |
| `tar.ts`      | `tarDirectory()` / `makeTar()`: creates tar streams for uploading files into a container via Docker's `putArchive` API.                                                                                                                   | (node:stream, tar-stream)                                              |
| `worktree.ts` | `WorktreeSandbox`: alternative `Sandbox` backed by a git worktree instead of Docker. Used in `iaso serve` for local-dev mode (no Docker needed).                                                                                          | `sandbox/types`                                                        |

### `src/sources/`

Where the issue text and repository come from.

| File                                | Purpose                                                                                                                                                 | Key relations   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `types.ts`                          | `Source` interface: `{ repoPath, issue, label, issueUrl?, commit?, cleanup() }`.                                                                        | (no deps)       |
| `local.ts`                          | `localSource()`: reads the issue from a file, uses the existing repo path. No cloning.                                                                  | `sources/types` |
| `swebench.ts`                       | `SweInstance` type, `renderSweIssue()` formats a SWE-bench problem statement into the issue text the agent sees.                                        | `sources/types` |
| `github.ts` (inferred from imports) | `githubSource()`: clones the repo at the issue's commit using `git`, fetches the issue body via GitHub API. `parseIssueUrl()` splits owner/repo/number. | `sources/types` |

### `src/tools/`

The tools the agent can call. Each tool is a `Tool` object: `{ definition: ToolDef, execute(input, ctx) }`.

| File               | Purpose                                                                                                                                                                       | Key relations                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `schema.ts`        | `Tool` type, `runTool()`, `toToolDef()`. Zod-validates tool input, calls `execute()`, catches errors into `{ output, isError }`.                                              | `providers/types`, `sandbox/types`, `context/state` |
| `bash.ts`          | `bashTool`: runs an arbitrary shell command in the sandbox. Output is capped at 5 MB, then shaped and truncated. Passes `timeoutSec` from the remaining run time.             | `sandbox/types`, `tools/paths`, `tools/truncate`    |
| `readonly-bash.ts` | `readonlyBashTool`: like `bashTool` but refuses commands that modify the repo (detected by a blocklist). Used in the plan phase.                                              | `tools/bash`                                        |
| `read-file.ts`     | `readFileTool`: reads a file from `/repo`. Validates path is under `/repo`.                                                                                                   | `sandbox/types`, `tools/paths`                      |
| `edit-file.ts`     | `editFileTool`: applies a string replacement inside a file. `shellQuote()` is a helper used elsewhere (e.g. `verify.ts`).                                                     | `sandbox/types`, `tools/paths`                      |
| `notes.ts`         | `notesTool`: merges a `TaskStatePatch` into `RunState.task`. Updates `lastNotesStep`. The tool that keeps the agent's structured memory across context compactions.           | `context/state`                                     |
| `submit.ts`        | `submitTool`: validates and stores a `Submission` on `RunState`. The loop ends when this is set.                                                                              | `context/state`                                     |
| `submit-plan.ts`   | `submitPlanTool`: validates and stores a `Plan` on `RunState`. Ends the plan phase.                                                                                           | `context/state`                                     |
| `read-output.ts`   | `makeReadOutputTool()`: lets the agent re-read the full output of a previous tool call that was shortened. `FileOutputStore` saves shortened outputs to `runs/<id>/outputs/`. | `sandbox/types`                                     |
| `paths.ts`         | `resolveRepoPath()`: resolves a path to an absolute path under `/repo`, refusing any path that escapes it.                                                                    | (no heavy deps)                                     |
| `truncate.ts`      | `truncateOutput()`: trims tool output to `MAX_OUTPUT_CHARS`, keeping a tail.                                                                                                  | (string processing)                                 |
| `repair.ts`        | `repairToolInput()`: heuristically fixes malformed JSON inputs from models that sometimes wrap JSON in markdown fences.                                                       | (string processing)                                 |

### `src/telemetry/`

| File            | Purpose                                                                                                                                                                                               | Key relations |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `trajectory.ts` | `TrajectoryWriter.append()` writes one `TrajectoryStep` JSON line to `trajectory.jsonl`. Append-only: a crash loses at most one step. `ContextEvent` records compactions, drops, and loop detections. | (Node.js fs)  |
| `cost.ts`       | `CostTracker.add()` accumulates token usage and returns the USD cost for that call. `ModelPrices` has `inputPrice`, `outputPrice`, `cachedInputPrice` (all per million tokens).                       | (arithmetic)  |

### `src/bench/`

| File         | Purpose                                                                                                                            | Key relations                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `runner.ts`  | `runBenchTask()`: runs one SWE-bench instance, writes `predictions.jsonl` and `tasks.jsonl`. `BenchError` for task-level failures. | `agent/attempts`, `sandbox/prebuilt`, `sources/swebench` |
| `harness.ts` | Calls the official SWE-bench Python harness in a venv (`~/.iaso/swebench-venv`). Installs it on first run. Reads the JSON result.  | `bench/runner`                                           |
| `results.ts` | Formats `results.md` from `tasks.jsonl` + harness output.                                                                          | (file I/O, string formatting)                            |

### `src/oss/`

Open-source project intelligence.

| File             | Purpose                                                                                                                                                                                                   | Key relations        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `conventions.ts` | `readConventions()`: scans CONTRIBUTING, PR template, `AGENTS.md`, any file named `AI*` for AI policy excerpts. Detects DCO, CLA, changelog requirements. `describeConventions()` formats a summary line. | (fs walking, regex)  |
| `claim.ts`       | `checkIssueClaim()`: queries the GitHub API to see if the issue is closed, locked, assigned, or already has a closing PR. Returns a `ClaimReport` with `blockers`.                                        | (GitHub REST API)    |
| `find.ts`        | `findIssues()`: searches GitHub for scored `good first issue` bugs, filters by activity and outside merge rate.                                                                                           | (GitHub Search API)  |
| `limits.ts`      | GitHub rate limit tracking and wait logic.                                                                                                                                                                | (GitHub API headers) |
| `publish.ts`     | `publishPr()`: forks the repo, creates a branch, pushes the patch, opens a draft PR via `gh`. Checks the 2-PR-per-repo-per-24h cap.                                                                       | (`gh` CLI, fs)       |

### Root-level files

| File            | Purpose                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts` | `IasoConfig` schema (`.iaso.json`). `loadConfig()`, `parseConfig()`. `BUDGET_DEFAULTS`.                                                                    |
| `src/models.ts` | `ModelEntry` / `Catalogue` schemas. `loadCatalogue()`, `findModel()`, `hasApiKey()`. Loaded from `models.json` at runtime.                                 |
| `models.json`   | Static model catalogue. Each entry: `id`, `provider`, `apiModel`, `inputPrice`, `outputPrice`, `cachedInputPrice`, `contextWindow`, `toolCalls`, `effort`. |

---

## Key abstractions

### `Sandbox` (`src/sandbox/types.ts`)

The only interface the agent touches for code execution. Any implementation (`DockerSandbox`, `WorktreeSandbox`, or a test fake) works. The contract:

```
start()           → pulls image, copies /repo, tags iaso-baseline
exec(cmd)         → runs cmd in /repo, returns { exitCode, stdout, stderr, timedOut }
readFile(path)    → returns file content (absolute path under /repo)
writeFile(path)   → writes content
diff()            → unified diff of everything changed since start()
setNetwork(bool)  → enable/disable outbound network
destroy()         → remove the container; idempotent
```

### `ModelProvider` (`src/providers/types.ts`)

The only interface the agent touches for model calls:

```
id: string
chat(request, options?) → ChatResponse
```

A `ChatRequest` contains system prompt, messages (with tool calls and results), tool definitions, and optionally `effort`. A `ChatResponse` has `content` (text + tool call blocks), `stopReason`, and `usage`.

### `Tool` (`src/tools/schema.ts`)

```
definition: { name, description, inputSchema }
execute(input, ctx) → { output: string, isError: boolean }
```

`ctx` carries `sandbox`, `step`, `run` (mutable `RunState`), and `timeLeftSec`. Tools read and write `run.task` (notes) and set `run.submission` or `run.plan` to end a phase.

### `TaskState` (`src/context/state.ts`)

The agent's structured notes. Fields survive every context compaction in full:

```
phase              → current phase (plan|reproduce|fix|verify|report)
rootCauseHypothesis
confirmedFacts[]   → stamped with the step that proved each one
filesExamined[]    → { path, why }
failedApproaches[] → { what, whyItFailed } — never discarded
testsRun[]         → { cmd, result, step }
todo[]
```

`mergeTaskState()` is the only way to update it. `confirmedFacts` and `failedApproaches` only grow; the agent cannot erase a failed approach by accident.

---

## The agent loop in detail

`runLoop()` in `src/agent/loop.ts`:

```
for step = 1, 2, 3, ...:
  1. check budget (steps, cost, time) → end if exceeded
  2. prepare() → compact or trim the context if needed
  3. buildRequest() → ChatRequest (layers: system + issue + plan + summary + state + working set + history)
  4. provider.chat(request) → ChatResponse
  5. if no tool calls:
       nudge once ("Use a tool or call submit.")
       second time with no tools → end as "no_tool_use"
  6. for each tool call:
       approve via hooks (auto / ask / deny)
       runTool() → output
       if edit_file succeeded → update working set
  7. LoopDetector.observe() each call → if repeat:
       nudge (up to MAX_LOOP_NUDGES=2)
       next repeat → end as "stuck"
  8. add notes nudge if >8 steps since last notes call
  9. add budget warning nudge if >80% of any limit used
 10. logStep() → append to trajectory.jsonl
 11. if submission or plan set → end as "submitted"
```

**Context management (step 2):**

- If token count ≥ 50% of `contextWindow`: call the compact model to summarize old steps.
- If token count ≥ 85% of `contextWindow` and a summary exists: drop the summary.
- If still ≥ 85%: drop all but the last 4 steps.

The compact model receives the old steps + previous summary and returns a new summary with the fixed schema (`learned`, `files`, `tests`, `failedApproaches`).

---

## Context window management

`buildRequest()` constructs a layered `ChatRequest`:

```
1. system prompt      (cached)
2. issue text         (cached)
3. plan (if set)      (cached)
4. compacted summary  (if any)
5. task state (notes)
6. working-set files  (recently edited files, fresh content)
7. message history    (recent steps in full, older ones may be dropped)
```

Layers 1–3 are marked with `cacheBreakpoint: true` so the provider can cache them across steps. The working set is rebuilt from live sandbox content after every edit.

The `ContextMeter` estimates token count by dividing character count by 4. `thresholdsFor(contextWindow)` returns `{ compactAt: 0.5 * window, compactTarget: 0.25 * window, hardLimit: 0.85 * window }`.

---

## How the Session API works

`src/core/session.ts` is the bridge between `iaso serve` (or any future UI) and the pipeline:

1. `createSession(opts)` creates a `PushQueue<SessionEvent>` and wires up `LoopHooks`.
2. `session.start()` calls `runPipeline()` in the background, pushing events into the queue.
3. The caller iterates `session.events` to consume them.
4. `session.send(control)` resolves pending approval promises or sets `cancelRequested`.

The event types are:

- `step_started` → `run.in-progress` (first one only, from `serve.ts`)
- `text_delta` → `message.part { kind: "text" }`
- `tool_call` → `message.part { kind: "tool_call" }`
- `tool_result` → `message.part { kind: "tool_result" }`
- `approval_requested` → `run.awaiting`
- `context_event` → `message.part { kind: "context" }`
- `finished` → `run.completed` / `run.failed` / `run.cancelled`

`ApprovalPolicy` has a `default` (`auto` | `ask` | `deny`) and per-tool `rules`. `iaso serve` defaults every tool to `ask`, so callers can gate each tool call.

---

## Outputs written per run

| File                                  | Written by                | Contents                                                            |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `runs/<id>/issue.md`                  | `pipeline.ts`             | The issue text the agent saw (for `iaso replay --context`)          |
| `runs/<id>/plan.json`                 | `pipeline.ts`             | Structured plan (Zod-validated `Plan`)                              |
| `runs/<id>/conventions.json`          | `commands/run.ts`         | Conventions read from the repo (minus the `notes` field)            |
| `runs/<id>/trajectory.jsonl`          | `telemetry/trajectory.ts` | One JSON line per step: tokens, tool calls, results, context events |
| `runs/<id>/plan-N.trajectory.jsonl`   | `agent/pipeline.ts`       | Trajectory for the N-th plan round                                  |
| `runs/<id>/outputs/<step>-<call>.txt` | `tools/read-output.ts`    | Full output of a tool call that was shortened                       |
| `runs/<id>/report.md`                 | `agent/report.ts`         | Human-readable report                                               |
| `runs/<id>/patch.diff`                | `agent/report.ts`         | The unified diff                                                    |
| `runs/<id>/run.json`                  | `agent/report.ts`         | Structured metadata (`RunInfo`) for `iaso pr`                       |
| `runs/<id>/attempt-N/`                | `agent/attempts.ts`       | Same structure for each attempt when `--attempts > 1`               |
| `runs/<id>/pr-draft.md`               | `commands/pr.ts`          | Draft PR title + body                                               |

---

## Adding a new command

1. Create `src/commands/<name>.ts` with a `register<Name>(program, deps?)` function.
2. Import and call it in `src/cli.ts :: buildProgram()`.
3. Use `CommandDeps` from `commands/run.ts` as a template for injectable dependencies (makes the command testable without hitting real services).
4. Write a unit test in `test/commands-<name>.test.ts` using fake deps.

---

## Adding a new provider

1. Add an entry to `models.json` with the right `provider` value.
2. Create `src/providers/<name>.ts` implementing `ModelProvider`.
   - Map `ChatRequest` → the SDK's request format.
   - Map the SDK's response → `ChatResponse` (use `"tool_use"` / `"end_turn"` / `"max_tokens"` / `"error"` for `stopReason`).
   - Wrap in `withRetry()` from `providers/retry.ts`.
3. Add a case to `createProvider()` in `providers/registry.ts`.
4. Add the env var name (or `null` for keyless) to `PROVIDER_KEY_ENV` in `src/models.ts`.
5. Write tests using the mock in `providers/mock.ts` as a reference.

---

## Testing strategy

| Test group           | Location                       | How to run                                      | What it needs                        |
| -------------------- | ------------------------------ | ----------------------------------------------- | ------------------------------------ |
| Unit                 | `test/*.test.ts`               | `npm test`                                      | Nothing (uses mocks)                 |
| Integration (Docker) | `test/integration/`            | `IASO_DOCKER=1 npx vitest run test/integration` | Running Docker daemon                |
| Live model           | `test/live/`                   | `IASO_LIVE=1 npx vitest run test/live`          | `ANTHROPIC_API_KEY`                  |
| Network (GitHub)     | `test/net/` (via `IASO_NET=1`) | `IASO_NET=1 npx vitest run test/sources-clone`  | Internet + optionally `GITHUB_TOKEN` |

**Rule of thumb:** every unit test that touches a command uses `CommandDeps` / `ServeDeps` fakes. Tests that touch the sandbox use `FakeSandbox` from `test/helpers/fake-sandbox.ts`. Tests that touch the model use `MockProvider` from `src/providers/mock.ts`.

The `test/helpers/fixture-run.ts` helper sets up a minimal `LoopOptions` with a fake sandbox and mock provider, useful for testing loop behavior without full pipeline wiring.

---

_Keep this file up to date when you change how the system works. Specifically update: the data flow diagram when new phases or layers are added, the module map when files are created or removed, and the key abstractions section when interfaces change._

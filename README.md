# Iaso

Iaso (Ἰασώ) is the Greek goddess of recovery and healing; this agent brings broken code back to health.

Iaso is a command-line coding agent. It takes a bug report and a repository, reproduces the bug with a failing test, applies a minimal fix, runs the tests, and outputs a patch. A human reviews the patch and opens the PR. Iaso never pushes code.

> Status: early development (M7 done, part of M12 built). `iaso models`, `iaso plan`, `iaso run` and `iaso replay` work, from a local repo or a GitHub issue URL. `iaso bench` runs a seeded SWE-bench Lite sample and grades it with the official harness. `iaso pr` drafts a pull request from a finished run; opening it is still a manual step.

## Try it

Requires Node 22+.

```sh
npm install
npx tsx src/cli.ts --help
npx tsx src/cli.ts models
```

`iaso models` lists the model catalogue and shows which API keys are set. API keys are read from environment variables only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`).

Copy `.env.example` for the list of variables. Iaso does not load `.env` files; export the variables in your shell. Prices in `models.json` are unverified placeholders for now.

## Run it on a bug

Iaso runs the agent in a Docker sandbox, so Docker must be running. On Docker Desktop for Mac, point it at the socket first: `export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`.

```sh
# From a GitHub issue: Iaso reads the issue and clones the repo (read-only)
export ANTHROPIC_API_KEY=...
npx tsx src/cli.ts run --github https://github.com/OWNER/REPO/issues/123 --model anthropic:claude-haiku-5-5

# From a local repo and a bug report in a file
npx tsx src/cli.ts run --repo ./my-project --issue ./bug.md
```

Each run writes a folder under `./runs/<runId>/` (change it with `--runs`) with `patch.diff` (the fix), `report.md` (status, steps, cost, and for GitHub runs the issue URL and commit), and `trajectory.jsonl`. Apply the patch to a checkout of the commit named in the report: `git apply runs/<runId>/patch.diff`. Iaso never pushes, opens a PR or comments on the issue; you review the patch and do that yourself.

`GITHUB_TOKEN` is optional. It raises the GitHub rate limit and lets Iaso read private repos. It stays on your machine and is never passed into the sandbox or stored in the clone. A cloned repo's `.iaso.json` is ignored unless you pass `--config`, because that file can pick the Docker image and add rules to the prompt. Only `/issues/N` URLs work; GitLab and Bitbucket are not supported yet.

A run stops at its limits: `--max-steps` (default 50), `--max-cost` (default $1) and `--max-time` (default 20 minutes). A real repo with a slow test suite may need more, for example `--max-cost 2 --max-time 40`.

## Contribute a fix to an open-source project

Iaso never pushes code or opens a pull request on its own. You stay the author and answer for every PR; Iaso helps you get a reviewed patch and a draft, and sends it only when you add `--push` and type the repository's name.

1. **Run it on a GitHub issue:** `iaso run --github <issue url>`. Before cloning or spending anything, Iaso checks (read-only) that nobody else is on the issue: it stops if the issue is closed, locked or assigned, if an open pull request from the last 90 days says it closes the issue, or if a pull request is linked on the issue page; it only warns about older or merely mentioning pull requests, earlier closed attempts, and comments like "I'll take this". There is no flag that overrides a stop. Then it reads the project's contribution rules from the clone: `CONTRIBUTING`, the PR template, any AI policy, `AGENTS.md`, plus commit style, DCO sign-off and CLA mentions. It saves them to `runs/<id>/conventions.json`. If the rules appear to forbid AI-generated code or contributions, it stops and quotes the lines. This is keyword matching, so it can miss a rule or misread a sentence: read the project's rules yourself too.
2. **Check the patch yourself.** `runs/<id>/patch.diff` is the fix, `report.md` says what the agent did. Apply it to a fresh clone, run the project's own tests and linter, and confirm the new tests fail without the fix. The agent's own test notes and its confidence are not evidence.
3. **Draft the PR:** `iaso pr <runId>` shows the files, the full diff, what the project asks of you (CLA, sign-off, changelog, AI policy) and a draft title and body, saved as `runs/<id>/pr-draft.md`. On its own it does not change anything on GitHub. The title and summary are the agent's, and the choices it says the issue left open are listed behind a `[TODO]` marker for you to check. Anything only you can say (that you reviewed the change, that you ran the tests, that an AI helped) is a `[TODO]` marker, and no checkbox in the project's template is ticked. Read and edit the draft: the generated title and summary are a starting point and are often not good enough to send as they are.
4. **Open it:** once every `[TODO]` marker is resolved, run `iaso pr <runId> --push`. It lists what it will do (fork, push one branch to your fork, open a draft PR), then asks you to type `owner/repo`; anything else cancels, and no flag skips the question. It needs `gh` logged in. The commit is by your git name and your GitHub no-reply address (`--name` and `--email` change that), with a `Signed-off-by` line if the project asks for one. It refuses while a marker is left, after two PRs to the same repo in 24 hours (counted in `runs/oss-log.jsonl`), and for a run that already has a PR. The PR is always a draft: you mark it ready yourself.

Be a considerate contributor: pick an issue nobody has claimed (no assignee, no linked PR), read the project's rules, and open one PR at a time. Maintainers can be slow to respond.

## Replay a run

```sh
npx tsx src/cli.ts replay <runId>                 # print the trajectory
npx tsx src/cli.ts replay <runId> --context 12    # print what the model saw at step 12
```

## Benchmark

`iaso bench` runs a seeded sample of SWE-bench Lite in Docker, using the official per-instance images with the network cut for the agent. It writes `predictions.jsonl`, grades it with the official SWE-bench harness, and writes `results.md`. It has no default size because it costs money: you must pass `--sample <n>`.

```sh
npx tsx src/cli.ts bench --sample 10 --seed 42 --model anthropic:claude-haiku-5-5 --max-cost 1
```

The first run creates a Python venv at `~/.iaso/swebench-venv` and installs the pinned harness there (Python 3.10 or newer is needed). Each instance image is about 1 GB and is removed after its task unless you pass `--keep-images`; grading downloads them again. Run one task at a time on a laptop: each sandbox may use 4 GB.

The folder is named from the options (`runs/bench-swebench-lite-<model>-seed42-n10`), so the same command finds it again. A crashed run continues with `--resume`. Pass `--no-evaluate` to skip grading.

One real run of that command: **7 of 10 resolved (95% confidence interval 40%-89%)**, for $1.02 in total (mean $0.10 per task). Ten tasks is a small sample, so that range is wide.

Use `--max-total-cost <usd>` to cap the whole bench: it stops starting tasks when too little is left, holds a running task to what remains, and counts earlier spending in the folder, so `--resume` cannot go past it. Tasks that never started get no record, and `--resume` with a higher limit runs them. `results.md` marks such a run as partial.

Other options: `--concurrency`, `--plan-model`, `--compact-model`, `--no-plan`, `--max-steps`, `--max-cost` (per task), `--max-time`, `--out`, `--resume`, `--keep-images`, `--refresh`, `--max-total-cost`, `--no-evaluate`. See `iaso bench --help`.

## Project config

A repo can carry a `.iaso.json` with optional `image`, `installCommand`, `testCommand`, `relatedTestsPattern`, `extraRules` and `services`. Pass it with `--config`; it is read automatically for local repos only.

## Layout

```
src/
  cli.ts          entry point (commander)
  commands/       models, run/plan, replay, bench, pr
  agent/          loop, plan phase, pipeline, prompts, report, budget
  context/        token budget, shaping, staleness, loops, compaction, layers
  providers/      Anthropic, OpenAI-compatible, mock, registry, retry
  sandbox/        Docker sandbox, images, prebuilt SWE-bench images
  sources/        local repo, GitHub issue, SWE-bench loader
  tools/          bash, read_file, edit_file, notes, submit, submit_plan
  telemetry/      cost and trajectory logging
  bench/          benchmark runner, harness call, results
  oss/            project contribution rules and AI-policy reading
test/             unit tests, plus opt-in integration, live and net tests
models.json       model catalogue
```

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Two test groups are off by default because they need outside resources:

```sh
# Real Docker (needs a running daemon; the first run pulls a ~1 GB image)
IASO_DOCKER=1 npx vitest run test/integration

# Real model API (costs a few cents; needs ANTHROPIC_API_KEY in your environment)
IASO_LIVE=1 npx vitest run test/live

# github.com (reads one public issue and clones its repo; a GITHUB_TOKEN raises the rate limit)
IASO_NET=1 npx vitest run test/net
```

Progress and the build plan are tracked in `PROGRESS.md`.

License: MIT (declared in `package.json`; there is no LICENSE file yet).

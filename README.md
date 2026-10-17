# Iaso

Iaso (Ἰασώ) is the Greek goddess of recovery and healing; this agent brings broken code back to health.

Iaso is a command-line coding agent. It takes a bug report and a repository, reproduces the bug with a failing test, applies a minimal fix, runs the tests, and outputs a patch. A human reviews the patch and opens the PR. Iaso never pushes code.

> Status: early development (M6 done). `iaso models`, `iaso plan`, `iaso run` and `iaso replay` work, from a local repo or a GitHub issue URL; `bench` is not built yet.

## Try it

Requires Node 22+.

```sh
npm install
npx tsx src/cli.ts --help
npx tsx src/cli.ts models
```

`iaso models` lists the model catalogue and shows which API keys are set. API keys are read from environment variables only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`).

Prices in `models.json` are unverified placeholders for now.

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

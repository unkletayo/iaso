# Iaso

Iaso (Ἰασώ) is the Greek goddess of recovery and healing; this agent brings broken code back to health.

Iaso is a command-line coding agent. It takes a bug report and a repository, reproduces the bug with a failing test, applies a minimal fix, runs the tests, and outputs a patch. A human reviews the patch and opens the PR. Iaso never pushes code.

> Status: early development (M1, skeleton). Only `iaso models` works today.

## Try it

Requires Node 22+.

```sh
npm install
npx tsx src/cli.ts --help
npx tsx src/cli.ts models
```

`iaso models` lists the model catalogue and shows which API keys are set. API keys are read from environment variables only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`).

Prices in `models.json` are unverified placeholders for now.

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
```

Progress and the build plan are tracked in `PROGRESS.md`.

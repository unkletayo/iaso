# Iaso progress

Source of truth for what is done and what is left. Spec: `iaso-build-prompt.md`.
Status: `[x]` done, `[~]` in progress, `[ ]` todo. Update this file at the end of every phase.

## Decisions log

- ESM, Node 22+, TypeScript 6.0.x (pinned: typescript-eslint 8.71 peers `typescript <6.1`).
- Added dev deps beyond spec list: `@eslint/js`, `typescript-eslint`, `@types/node` (needed to lint and type TS).
- `models.json` prices are placeholders until verified before M2.
- npm publish of `0.0.1` and GitHub repo creation: deferred until user says go.

## M1: Skeleton (current)

- [x] 1A tooling: `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.prettierignore`
  - [x] deps installed
  - [x] `tsc --noEmit` clean (verified in 1B)
  - [x] `eslint . --quiet` clean (verified in 1B)
- [x] 1B config + catalogue: `src/config.ts`, `models.json`, `src/models.ts`, `test/config.test.ts`, `test/models.test.ts` (tsc, eslint clean; 16 tests pass)
- [x] 1C CLI: `src/cli.ts` (shebang, replaces `bin/iaso.ts` shim), `src/commands/models.ts`, `tsconfig.build.json`, `README.md`, `test/cli.test.ts` (21 tests pass; build and `node dist/cli.js models` verified)
- [x] Done when `iaso models` runs
- [ ] Deferred (needs approval): `npm publish` empty `0.0.1`, create GitHub repo `iaso`

## Later milestones

- [~] M2 Providers (live round trip: Anthropic only; user is getting a key)
  - [x] 2A neutral types, mock provider, retry (31 tests pass)
  - [x] 2B Anthropic adapter + SDKs installed (`@anthropic-ai/sdk` 0.134.0, `openai` 7.34.0); 39 tests pass
  - Decision: Anthropic adapter never sends `temperature` (SDK deprecates it; non-1.0 values 400 on newer models). M13 best-of-N must vary models, not temperature, for Anthropic.
  - Decision: `Usage.inputTokens` = whole prompt incl. cached; `cachedInputTokens` = cached part. Cost = (input - cached) * in + cached * cachedPrice.
  - [x] 2C OpenAI-compatible adapter + registry (55 tests pass). OpenAI temperature not sent (reasoning models reject it); `max_completion_tokens` for OpenAI, `max_tokens` for other servers; tool errors prefixed `[error]`.
  - [x] 2D live round-trip test (`test/live/roundtrip.live.test.ts`, `vitest.config.ts`). Passed against `anthropic:claude-haiku-5-5` (4.2s), run by the user in their own terminal (output pasted by user; the key is not in the agent's shell). Run: `IASO_LIVE=1 npx vitest run test/live`
  - [x] M2 done for Anthropic. OpenAI-compatible adapters remain fake-client tested only.
  - [ ] Verify `models.json` prices on official vendor pages (web lookup found only third-party sources, see below)
- [~] M3 Sandbox (Docker only; Podman and local mode are M9). Docker daemon was NOT running at last check; needed for 3C.
  - [x] 3A `sandbox/types.ts`, `images.ts`, `cleanup.ts` + tests (66 tests pass)
  - [x] 3B `sandbox/docker.ts`, `sandbox/tar.ts` (hand-rolled ustar writer + host `tar` streaming), dockerode 5.0.1 + @types/dockerode 4.0.2 (major mismatch; types compile, verify in 3C). 93 tests pass. Real Docker path (`dockerodeApi`) untested until 3C.
  - Decisions: CapDrop ALL + no-new-privileges, no swap, HOME=/tmp, `node_modules` not copied, baseline = git commit tagged `iaso-baseline`, `diff()` = `git add -A && git diff --cached --binary iaso-baseline`.
  - [x] 3C opt-in integration tests (`IASO_DOCKER=1 npx vitest run test/integration`): 9/9 pass on real Docker 29.4.3 (Docker Desktop, macOS). Covers: command runs as uid 1000 in /repo, limits + hardening via `docker inspect`, repo copy / node_modules skipped / diff / mode preserved, network cut (no eth0, connect fails) and restored, timeout kill, destroy, container gone after crash (try/finally), SIGTERM (exit 143) and SIGINT (exit 130). No containers leaked.
  - Bugs found by the real run (all fixed): `/repo` missing in plain images; macOS `com.apple.provenance` xattrs in tar made the daemon fail (`--no-xattrs --no-mac-metadata`); baseline errors lacked the exit code.
  - Known gap: the very first run got an unexplained HTTP 500 from `ensureImage` on `node:22-bookworm`. Not reproduced; the pull path works for `alpine:3.20` (13.7s). Likely transient.
  - Known gap: an uncaught exception outside try/finally, or SIGKILL, can still leak a container. Label `iaso.run` allows later cleanup (no `iaso clean` command yet).
  - [x] M3 done for Docker. Podman + unsafe local mode are M9.
- [ ] M4 Tools + loop + context mgmt part 1 (plan drafted, awaiting approval; spec §5, §7, §7A pts 1-5, §12)
  - [x] 4A tool foundations: `tools/schema.ts` (defineTool/toToolDef/parseToolInput/runTool), `tools/paths.ts`, `tools/truncate.ts`, 2 test files (116 tests pass). Decisions: gating = per phase; CLI wiring deferred; live proof run by user.
  - [x] 4B `bash`, `read_file`, `edit_file` + tests with in-memory fake Sandbox (154 tests pass). Decisions: non-zero exit is NOT a tool error (only timeout is); `edit_file` counts overlapping matches as separate (ambiguous); empty oldText only creates new files; `$` in newText stays literal. Also fixed in 3B: `readFile` refuses files > 4 MiB (capture cap is 5 MB, would have truncated silently).
  - [ ] 4C `context/state.ts` (TaskState), `submit`, `notes` tools + tests
  - [ ] 4D `telemetry/cost.ts`, `telemetry/trajectory.ts`, `agent/budget.ts` + tests
  - [ ] 4E `context/budget.ts` (token accounting), `shaping.ts`, `staleness.ts` + tests
  - [ ] 4F `context/layers.ts`, `agent/prompts.ts`, `agent/loop.ts` + tests (mock provider)
  - [ ] 4G fixture repo `test/fixtures/`, Docker e2e with scripted mock, live Haiku fix (user runs; costs cents)
- [ ] M5 Phases + plan mode + context mgmt part 2
- [ ] M6 Sources
- [ ] M7 Benchmark
- [ ] M8 Gemini, README, polish
- [ ] M9 Daily-use features
- [ ] M10 Portfolio package
- [ ] M11 Built-in eval harness
- [ ] M12 OSS contribution mode
- [ ] M13 Quality, cost, safety, workflow

## Open questions

- None.

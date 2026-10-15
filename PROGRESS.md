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
  - [~] 2D live round-trip test written (`test/live/roundtrip.live.test.ts`, `vitest.config.ts`); skips cleanly without key. NOT yet run against the real API: needs `ANTHROPIC_API_KEY`. Run: `IASO_LIVE=1 npx vitest run test/live`
  - [ ] M2 done only after the live run passes
  - [ ] Verify `models.json` prices on official vendor pages (web lookup found only third-party sources, see below)
- [~] M3 Sandbox (Docker only; Podman and local mode are M9). Docker daemon was NOT running at last check; needed for 3C.
  - [x] 3A `sandbox/types.ts`, `images.ts`, `cleanup.ts` + tests (66 tests pass)
  - [ ] 3B `sandbox/docker.ts` (dockerode, fake-client tests), `npm i dockerode @types/dockerode`
  - [ ] 3C opt-in integration tests (`IASO_DOCKER=1`): command runs inside, limits, network cut, container gone after crash
- [ ] M4 Tools + loop + context mgmt part 1
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

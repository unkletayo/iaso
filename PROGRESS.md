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

- [ ] M2 Providers
- [ ] M3 Sandbox
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

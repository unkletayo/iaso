# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 19 + Vite + TypeScript + Tailwind CSS. Served locally by the iaso binary (the UI is bundled into the package; `iaso serve --stdio` is the backend transport). No separate server process for the developer.

## Users

Primary: a solo software developer running Iaso on their local machine. They are in the middle of a development session — a bug to fix, a PR to open — and they open the UI because they want to watch the agent work and review its output without staying in the terminal. The architecture is designed to scale to multi-user/hosted in a future milestone; every design and data decision should leave that door open.

## Product Purpose

Iaso's web UI is the control surface for the coding agent. It makes three jobs fast and clear: starting a run, watching it happen in real time (with the ability to approve or cancel tool calls), and reviewing the patch when it's done. The terminal stays the power interface; the UI earns its place by being faster and clearer for the watch-and-review loop.

## Positioning

The only UI for a coding agent that shows you exactly what the model did at every step — not just the diff, but the reasoning, the tool calls, and the failed approaches — so you can review it like a code review, not a black box.

## Operating Context

- Opened in a browser tab while the developer's editor is in another window.
- The agent run takes 1–20 minutes; the developer may leave and come back.
- The developer reviews the patch before applying it; the UI is part of that review workflow.
- Run history grows over time; older runs must remain browsable.
- Future: a team may share one Iaso server; run ownership and visibility will matter.

## Capabilities and Constraints

- Backend transport: `iaso serve --stdio` streams `ServeEvent` JSON-lines to stdout; the UI writes `ServeControl` JSON-lines to stdin.
- Event types: `run.created`, `run.in-progress`, `message.part` (text/tool_call/tool_result/context), `run.awaiting`, `run.completed`, `run.failed`, `run.cancelled`.
- The UI can approve, reject, or cancel via control messages.
- Run artifacts (`report.md`, `patch.diff`, `run.json`, `trajectory.jsonl`) are on disk in `runs/<runId>/`.
- No authentication in V1 (local only); the architecture must not make it impossible to add later.
- Must-have screens V1: Start a run · Live step feed · Approval/cancel · Run history + diff viewer.

## Brand Commitments

Name: Iaso. No existing visual identity or logo to preserve. The name and the Greek-healer origin story are the only brand assets. Voice: precise, direct, no marketing fluff — a tool made by and for developers.

## Evidence on Hand

- Full backend codebase in `src/` (TypeScript, Node 22).
- `ServeEvent` and `ServeControl` wire formats fully defined in `src/commands/serve.ts`.
- Real run artifacts in `runs/` (trajectory JSONL, report.md, patch.diff, run.json).
- Benchmark result: 7 of 10 SWE-bench Lite tasks resolved at $0.10 per task.

## Product Principles

1. **Transparent by default.** Every step the agent took is accessible, not hidden inside a summary. The developer should be able to understand exactly what happened without reading a log file.
2. **Review-grade fidelity.** The diff and patch view must meet the bar of a code review — syntax-highlighted, navigable, with enough context to judge the change.
3. **Scales without redesigning.** Solo-local today; the information architecture and permission model must not break when multi-user and hosted are added.
4. **Tool, not toy.** No decorative animations, no gamification. Motion only where it carries meaning (streaming text, state transitions). Density over whitespace when the user is working.
5. **Fast to the first useful thing.** A developer opening the app to start a run should be able to do that in under 10 seconds from first load.

## Accessibility & Inclusion

WCAG 2.1 AA. Keyboard-navigable approval/cancel flow (the developer may not reach for the mouse mid-run). High-contrast text on code blocks.

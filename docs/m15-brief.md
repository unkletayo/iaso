# M15 — Iaso Web UI: Locked Shape Brief

**Mode:** Operate — the developer completes a task (start, watch, approve, review).
**Stack:** React 19 + Vite + TypeScript + Tailwind CSS. Served by the iaso binary.
**Branch:** branch off `main` when building.

---

## 1. Job and audience

A solo developer opens the UI mid-session to find or bring an issue, start an Iaso run, watch the agent work in real time, approve or reject tool calls without staying in the terminal, and review the resulting patch before applying it. They are in a split-attention state: the UI is in one browser tab, their editor in another. Architecture must leave the door open for multi-user hosted deployment in a later milestone.

---

## 2. Outcome and proof

The developer can find or specify a bug, start a run, approve its tool calls, and review its patch entirely from the browser — no terminal, no JSON files.

---

## 3. Visual direction

**World:** Professional developer tooling. Reference: Linear, Railway, Warp. Dark-first. High information density. Monospace (`JetBrains Mono` or `IBM Plex Mono`) for all code, diffs, tool inputs/outputs. Geometric sans (`Inter` or `Geist`) for UI chrome. No body text — this is a tool. No decorative gradients or animations. Color is functional only:

| Meaning                | Color      |
| ---------------------- | ---------- |
| Running / awaiting     | Amber      |
| Submitted / verified   | Green      |
| Failed / stuck / error | Red        |
| Cancelled              | Muted grey |

Motion only where meaningful: streaming text arriving, step card expanding, status chip transitioning.

---

## 4. Screens and information architecture

```
┌─────────────────────────────────────────────────────────┐
│  [iaso]              [New run]                 [Models] │
├──────────────┬──────────────────────────────────────────┤
│  Run history │  Main panel (context-dependent)         │
│              │                                          │
│  • run A ●  │  ┌── New run form / Discovery            │
│  • run B ✓  │  ├── Live feed (active run)             │
│  • run C ✗  │  └── Run detail (completed run)         │
└──────────────┴──────────────────────────────────────────┘
```

---

## 5. Screen specs

### Screen 1 — Run history (sidebar, 220px fixed)

- List: status chip · issue title (from `run.json`) · model · steps · cost · elapsed · timestamp
- Status chips: `running` (pulsing amber) · `submitted` · `failed` · `cancelled` · `stuck`
- Click completed run → Run Detail
- Click active run → Live Feed
- Empty state: "Start your first run" CTA
- > 50 runs: virtualised + search/filter by status

---

### Screen 2 — New run form + Issue Discovery (main panel)

**Step 1 — Source selector:**

```
How do you want to start?

  ○ GitHub issue URL     — paste a specific issue link
  ○ Local repo + issue   — repo path + issue file on disk
  ● Find me an issue     — search GitHub for something worth fixing
```

Model, budget, and plan-toggle only appear after an issue is confirmed.

**GitHub issue URL path:** single URL input with inline validation → confirm → proceed to run config.

**Local repo + issue path:** repo path input + issue file path (or paste issue text) → proceed to run config.

**Find me an issue path:**

- Text input: "GitHub repo URL, topic, or search prompt"
  - e.g. `https://github.com/owner/repo` · `typescript good first issue` · `find a bug in a React charting library`
- Language filter (optional dropdown)
- Label filter (optional: `bug` · `good first issue` · `help wanted`)
- "Find issues" button → calls `iaso find` with parsed parameters
- If input is a bare repo URL, `iaso find` is scoped to that repo; otherwise general search

**Discovery results screen** (replaces form in main panel):

- Scored issue cards:
  - Issue title + repo name (linked)
  - Score badge (0–100) + top 2 scoring reasons
  - Labels · comment count · age
  - Claim status inline (closed/assigned/already-PRd shown as warning, not blocker)
- "Use this issue" → pre-fills GitHub URL into run config and advances
- "Search again" link

**Run config** (after issue confirmed from any path):

- Model: dropdown populated from `iaso models`, grouped by provider
- Budget: step limit · cost limit ($) · time limit (min) — collapsed by default, expandable
- Plan phase: toggle (default on)
- "Start run" — full-width primary button

---

### Screen 3 — Live feed (active run)

- Header bar: run ID · model · elapsed · `step N` · cost so far · Cancel button
- **Approval banner** (when `run.awaiting`): full-width amber strip pinned to top — tool name · input preview · Approve / Reject — keyboard `A` / `R`
- Step cards, newest at bottom, auto-scroll:
  - Model text (streamed in as it arrives)
  - Tool call card: name + collapsed input (expand toggle) · result below (expandable) · error in red
  - Context event pills: "compacted" · "loop detected" · "stuck" — inline, muted
- Auto-scroll pauses when user scrolls up; "↓ Follow" anchor resumes it

---

### Screen 4 — Run detail (completed run)

**Left column (40%) — summary:**

- Status · model · steps · cost · time · verification result (`verified` / `failed` / `not_checked`)
- Issue title + truncated body
- Plan (if present) — collapsed by default
- Submission summary + confidence badge
- Tests added / tests run list
- Failed approaches

**Right column (60%) — tabs:**

- **Diff** (default): syntax-highlighted patch, file-by-file, `+` green · `-` red, file headers sticky. >500 lines: virtualised + jump-to-file index.
- **Report**: rendered `report.md`
- **Trajectory**: step-by-step feed, same card format as live feed, static + scrollable

---

## 6. Transport architecture

`iaso serve --stdio` runs as a child process (`node:child_process spawn`). A lightweight HTTP + WebSocket server (bundled into the iaso binary, e.g. Fastify) bridges stdio ↔ WebSocket so the React client consumes the stream. Endpoints:

| Endpoint                  | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `GET /api/runs`           | List run directories from `runs/`, read `run.json` from each               |
| `GET /api/runs/:id`       | Full run detail: `run.json`, `report.md`, `patch.diff`, `trajectory.jsonl` |
| `POST /api/runs`          | Start a new run (spawns `iaso serve --stdio` child)                        |
| `GET /api/models`         | List models from catalogue                                                 |
| `WS /api/runs/:id/stream` | Live event stream for active run; control messages back                    |
| `GET /api/find`           | Proxy to `iaso find` with query params                                     |

---

## 7. States

| State             | UI                                                              |
| ----------------- | --------------------------------------------------------------- |
| Empty (no runs)   | Centered empty state + CTA                                      |
| Run starting      | Sidebar entry with pulsing chip; feed shows "Starting sandbox…" |
| Streaming         | Step cards appear; header updates step/cost live                |
| Awaiting approval | Approval banner pins to top; feed pauses                        |
| Completed         | Chip flips to submitted; Run Detail loads automatically         |
| Failed / stuck    | Chip flips; message in feed and detail                          |
| Cancelled         | Chip flips to cancelled                                         |

---

## 8. Keyboard shortcuts

| Key   | Action                                           |
| ----- | ------------------------------------------------ |
| `A`   | Approve tool call (when approval banner visible) |
| `R`   | Reject tool call (when approval banner visible)  |
| `N`   | New run                                          |
| `Esc` | Cancel current run (with confirmation)           |

---

## 9. Scope

**In M15:**

- All four screens + issue discovery flow
- WebSocket bridge (stdio ↔ browser)
- `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs`, `GET /api/models`, `GET /api/find`
- Keyboard approval shortcuts
- Dark theme only

**Out of scope (future):**

- Authentication / multi-user
- Light mode
- Mobile layout (<1024px)
- Trajectory replay (`iaso replay --context N` reconstruction)
- Re-running / editing a completed run
- Settings UI (API keys, default model)
- `iaso pr` flow in-browser

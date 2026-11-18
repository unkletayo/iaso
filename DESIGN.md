---
name: Iaso Web UI
description: Dark developer control surface for a coding agent — run it, watch it, approve it, review the diff.
colors:
  bg: "#09090b"
  surface: "#18181b"
  border: "#27272a"
  text: "#f4f4f5"
  muted: "#a1a1aa"
  muted-deep: "#71717a"
  muted-faint: "#52525b"
  running: "#f59e0b"
  submitted: "#10b981"
  failed: "#ef4444"
  cancelled: "#71717a"
  approval-bg: "#451a03"
typography:
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono-data:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  mono-xs:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  default: "4px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  10: "40px"
components:
  button-primary:
    backgroundColor: "{colors.running}"
    textColor: "{colors.bg}"
    rounded: "{rounded.default}"
    padding: "10px 24px"
  button-primary-hover:
    backgroundColor: "#fbbf24"
    textColor: "{colors.bg}"
    rounded: "{rounded.default}"
    padding: "10px 24px"
  button-secondary:
    backgroundColor: "{colors.border}"
    textColor: "#e4e4e7"
    rounded: "{rounded.default}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-deep}"
    rounded: "{rounded.default}"
    padding: "4px 8px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.default}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.default}"
  status-chip-running:
    textColor: "{colors.running}"
    backgroundColor: "transparent"
  status-chip-submitted:
    textColor: "{colors.submitted}"
    backgroundColor: "transparent"
  status-chip-failed:
    textColor: "{colors.failed}"
    backgroundColor: "transparent"
  status-chip-cancelled:
    textColor: "{colors.muted-deep}"
    backgroundColor: "transparent"
---

# Design System: Iaso Web UI

## Overview

**Creative North Star: "The Reviewer's Console"**

Iaso's UI is not a chat window and not a summary dashboard. It is a reviewer's console — a surface designed for the act of watching an agent work and judging its output with the same rigor you would apply to a code review. Every design decision defers to that job: the developer is a reviewer, not a prompt author, and the UI earns no attention it does not need.

The world is near-black (zinc-950, #09090b). Surfaces are zinc-900 (#18181b). There is no decorative color: amber is "this needs your attention now," green is "this passed," red is "this failed." Color works exactly like a terminal's status output, and nothing else. The only gradients in the build are diff line tints at 10% opacity — functional colorization of changed code, not chrome.

Density is the value proposition. This UI is opened in a split-attention state — editor in one window, browser tab in another — so it must surface maximum information in minimum space. Labels are `text-xs` (12px). Metadata is `text-[10px]` (10px) in monospace. There is no body prose on any screen except the report tab, which renders agent-generated markdown.

**Key Characteristics:**

- Near-black background; zinc-900 surfaces; zinc-800 borders — a strict three-layer tonal stack
- Amber is the single accent; it appears only on active/awaiting state, focus rings, selected rows, and the primary CTA
- Monospace (JetBrains Mono) for all data — run IDs, costs, steps, elapsed times, tool names, diff lines
- No decorative shadows, no gradients, no glass
- Motion is limited to three named uses: status pulse on active runs, streaming cursor on live text, spinner on loading actions

## Colors

Functional only. Five semantic roles; no decorative palette.

### Primary

- **Amber Signal** (#f59e0b, `--color-running`): Active / awaiting / starting states, the primary CTA button, focus rings, selected sidebar row left-border, selected source-card border tint, active tab underline. Amber appears only where the developer's attention or action is required. Its scarcity is the point.

### Secondary

- **Verified Green** (#10b981, `--color-submitted`): Submitted runs, verification pass, tests that passed, diff addition lines. Used to confirm a finished-and-passing state.

### Tertiary

- **Error Red** (#ef4444, `--color-failed`): Failed runs, stuck runs, error tool results, diff deletion lines, failed tests. Used wherever a run or check did not succeed.

### Neutral

- **Near-Black Background** (#09090b, `--color-bg`): Root viewport. Only visible in the gutters around the layout.
- **Dark Surface** (#18181b, `--color-surface`): Sidebar, header bars, cards, panels, form inputs, all interactive surfaces.
- **Border** (#27272a, `--color-border`): Dividers, card outlines, input borders, section separators. One width (1px) used throughout.
- **Primary Text** (#f4f4f5, `--color-text`): Headings, input values, run titles, all foreground content requiring full legibility.
- **Secondary Text** (#a1a1aa, `--color-muted`): Labels, section headers, descriptions, secondary metadata. Zinc-400.
- **De-emphasis** (#71717a, `--color-cancelled`): Timestamps, metadata tertiary items, cancelled status. Zinc-500.
- **Faint** (#52525b): Context event pills (compacted / loop detected / stuck), cancelled status dots. Zinc-600. Used where information is present but should not compete.
- **Approval Background** (#451a03, `approval-bg`): The approval banner background. Amber-950 — the only named surface color outside the zinc ramp.

**Named Rules:**

**The One Accent Rule.** Amber (#f59e0b) is used in exactly one semantic category per screen: state that requires the developer's attention or the primary action available. It is never used decoratively, never used for category labels, never used to highlight completed or neutral content.

**The Cancelled Rule.** Cancelled is not an error. Its dot is zinc-600 (#52525b), not zinc-500; its label text is zinc-500 (#71717a). The distinction between cancelled and muted metadata is intentional and must be preserved.

## Typography

**UI Chrome Font:** Inter (with system-ui, sans-serif fallback)
**Data / Code Font:** JetBrains Mono (with ui-monospace, monospace fallback)

Both loaded via Google Fonts. `-webkit-font-smoothing: antialiased` applied globally.

**Character:** Inter at small sizes for compressed label density; JetBrains Mono for all measurements, identifiers, and machine output — a strict partition that makes human-readable labels and machine-generated data visually distinct without color.

### Hierarchy

- **Title** (Inter, semibold 600, 18px / line-height 1.4): Page headings only — "New run" and "Models". The only place Inter is used at a size above 14px.
- **Label** (Inter, medium 500, 12px / line-height 1.5): Form labels, section labels, button text, tab labels. The primary text size for all chrome.
- **Body-sm** (Inter, regular 400, 14px): Input values, run titles in detail view, section descriptions, prose in summary column. The largest regular-weight size.
- **Mono-data** (JetBrains Mono, regular 400, 12px / line-height 1.5): Status chips, tool names, run IDs, cost values, step counts, elapsed times, form inputs marked `font-mono`, diff file headers, inline code in reports.
- **Mono-xs** (JetBrains Mono, regular 400, 10px / line-height 1.4): Timestamps, step numbers, tool result type labels, `<kbd>` hints in approval buttons, model metadata in sidebar rows. Used where data must fit in constrained horizontal space.

**Named Rules:**

**The No-Body Rule.** This is a tool, not a document. Inter is never used for prose paragraphs on tool screens. The report tab renders agent-generated markdown via Tailwind Typography (`prose-sm prose-invert`) — this is an isolated rendering context for external content, not part of the design system's type hierarchy.

**The Mono-Data Rule.** Every value that could appear in a terminal — run IDs, costs, steps, model identifiers, tool call names, diff lines, file paths — uses JetBrains Mono. Inter is reserved for human-authored labels and instructions.

## Layout

Two-column master-detail shell: `flex h-full` on the root. Left column is the sidebar (fixed 220px, `w-[220px] min-w-[220px]`). Right column is the main panel (`flex-1 min-w-0`), which switches between four views: New Run form, Live Feed, Run Detail, and Models.

**Sidebar:** `bg-zinc-900 border-r border-zinc-800 h-full flex flex-col`. Header area `px-4 py-3` with bottom border. Run list `flex-1 overflow-y-auto`.

**New Run / Models pages:** Centered content column, `max-w-2xl mx-auto px-6 py-10`. Not full-bleed; leaves breathing room on wide screens.

**Live Feed:** Full-height flex column. Header bar `px-5 py-2.5` with bottom border. Approval banner (when visible) `px-5 py-3` immediately below, full width, shrink-0. Feed area `flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2`.

**Run Detail:** Two-column split inside the main panel. Left summary: `w-[40%] min-w-[280px] border-r border-zinc-800 overflow-y-auto px-5 py-5 flex flex-col gap-4`. Right tabs: `flex-1 flex flex-col`. Each column scrolls independently.

**Spacing rhythm:** 4px base. Gaps between metadata items: `gap-2` (8px). Section spacing: `gap-4` (16px). Content padding: `px-5 py-4` for feed, `px-5 py-5` for run detail column, `px-6 py-10` for form pages. Component internal padding: `px-3 py-2.5` for list rows, `px-3 py-2` for card headers.

**Min-width target:** ≥1024px. No responsive layout below 1024px (out of scope for M15).

## Elevation & Depth

This system is tonal, not shadow-based. Depth is communicated by the zinc ramp: zinc-950 (bg) → zinc-900 (surface) → zinc-800 (border/divider). No `box-shadow` on panels, sidebars, or cards.

The one exception is the ↓ Follow anchor button in the Live Feed: it uses Tailwind's `shadow-lg` to visually float above the feed content, making it clear it is a temporary overlay control. This is a structural elevation signal — the anchor appears only when the user has scrolled away from the bottom and disappears when auto-scroll resumes — not decorative.

**Named Rules:**

**The Tonal Stack Rule.** Surfaces at different depths are expressed only through the zinc ramp: near-black background, dark surface, border. No drop shadows create this layering. If a surface needs to feel elevated, it uses a zinc-900 background against the zinc-950 root; it does not add a shadow.

## Shapes

Corner radius: `rounded` (4px) consistently throughout — inputs, cards, tool call cards, buttons, filter label toggles, candidate issue cards. No sharp corners (0px), no large-radius pills (≥16px), no squircles.

**Named Rules:**

**The One Radius Rule.** The build uses one border-radius value everywhere: 4px (`rounded`). No mixed-radius treatment. Rounded pills (rounded-full) appear only on the status dots (1.5×1.5px circles), which are decoration-free markers, not interactive elements.

## Components

### Buttons

Dense, label-led, no icons except on icon-label pairs where the icon reinforces the label (Plus for New run, Search/Loader2 for Find, X for Cancel).

- **Shape:** Gently rounded corners (4px)
- **Primary (Start run):** Full-width, amber-500 background (#f59e0b), zinc-950 text (#09090b), font-semibold 14px Inter, `py-2.5`. Hover: amber-400 (#fbbf24). Disabled: 40% opacity, `cursor-not-allowed`. Loading state: `Loader2` spinner (14px, `animate-spin`) + "Starting run…" label.
- **Secondary (Find, action buttons):** zinc-800 background (#27272a), zinc-200 text (#e4e4e7), 14px Inter. Hover: zinc-700. Disabled: 40% opacity.
- **Ghost (sidebar nav, collapse toggles, cancel):** No background at rest. zinc-500 (#71717a) text. Hover: zinc-300 text + zinc-800 background tint (for sidebar buttons) or zinc-300 text only (for inline toggles). All transitions use `transition-colors`.
- **Approve (approval banner):** `bg-green-900/40 border border-green-700/50 text-green-400`, hover `bg-green-900/60`. 12px Inter, medium weight.
- **Reject (approval banner):** `bg-red-950/40 border border-red-800/50 text-red-400`, hover `bg-red-950/60`. 12px Inter, medium weight. Each includes an inline `<kbd>` hint at 10px mono (A / R).

### Status Chip

Inline-flex, font-mono 12px. Dot: 6×6px circle. The dot's animation state (pulsing or static) encodes whether the run is active.

| Status                           | Label text                    | Dot color | Pulse                 |
| -------------------------------- | ----------------------------- | --------- | --------------------- |
| created / in-progress / awaiting | starting / running / awaiting | amber-500 | yes (`pulse-running`) |
| submitted                        | submitted                     | green-500 | no                    |
| failed / stuck                   | failed / stuck                | red-500   | no                    |
| cancelled                        | cancelled                     | zinc-600  | no                    |

### Cards (Tool Calls and Results in Feed)

- **Tool call card:** `border border-zinc-800 rounded bg-zinc-900/60`. Expandable via chevron toggle (`ChevronRight` → `ChevronDown`, 12px, zinc-500). Header row: step number (10px zinc-500 mono) + tool name (12px amber-400 mono, medium weight) + collapsed input preview (12px zinc-500 mono, truncated). Expanded: full JSON `<pre>` in 12px zinc-300 mono.
- **Tool result (normal):** `border border-zinc-800/50 rounded bg-zinc-900/30`. Collapsed label: "result" in 10px zinc-600 mono.
- **Tool result (error):** `border border-red-900/50 bg-red-950/20`. Error label: "error" in 10px red-400 mono. Expanded text: red-300.
- **Context event pill:** Inline, `text-[10px] text-zinc-600 font-mono px-1`, formatted as `— <type> —` (hyphens, not em-dashes). Not a card — a text marker only.

### Inputs / Fields

Consistent pattern throughout: `bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50`. Mono inputs add `font-mono`. Select elements use the same shell at `text-xs text-zinc-400` for language/status filters. The focus treatment removes the default outline and shifts the border to `amber-500/50` — amber at half opacity. The global `:focus-visible` rule provides `2px solid amber-500 / outline-offset: 2px` for keyboard navigation.

### Navigation (Sidebar)

Run row: `w-full text-left px-3 py-2.5 hover:bg-zinc-800 transition-colors border-l-2`. Selected: `border-amber-500 bg-zinc-800/60`. Unselected: `border-transparent`. The 2px left-border selection indicator is the only persistent use of amber as a chrome element (not a status indicator).

Top nav buttons (Models, New run) are ghost buttons in the sidebar header, `px-2 py-1 rounded hover:bg-zinc-800`.

### Source Selector (New Run)

Radio card pattern: `flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors`. Selected: `border-amber-500/50 bg-amber-500/5`. Unselected: `border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/50`. The amber-500/5 tint (5% opacity fill) is the softest use of amber in the build — a selection state indicator that never overwhelms the content density.

### Tabs (Run Detail)

Tab bar: `border-b border-zinc-800 bg-zinc-900/80 shrink-0`. Tab item: `px-4 py-2.5 text-xs font-medium transition-colors`. Active: `text-zinc-100 border-b-2 border-amber-500`. Inactive: `text-zinc-500 hover:text-zinc-300`. The active tab uses amber underline — the third (and last) place amber appears on a completed-run screen.

### Diff View

File header: `sticky top-0 z-10 bg-zinc-900 border-b border-zinc-800 px-3 py-2`. Add count: green-500 (`+N`). Del count: red-500 (`-N`). Collapsible per file.

Diff lines use CSS classes in `index.css` (expanded from Tailwind utilities to literal values):

- Addition line: `background rgba(16,185,129,0.1)`, text `#6ee7b7`, gutter `#10b981`
- Deletion line: `background rgba(239,68,68,0.1)`, text `#fca5a5`, gutter `#ef4444`
- Hunk header: `background rgba(99,102,241,0.1)`, text zinc-400, `font-style: italic`
- Context line: zinc-600 text

### Scrollbar

Custom WebKit scrollbar: 6px width/height, transparent track, zinc-700 (#3f3f46) thumb with 3px radius, zinc-600 (#52525b) on hover.

## Do's and Don'ts

### Do:

- **Do** use zinc-800 (#27272a) borders at 1px for all card, panel, and divider separations. One border width, one border color across all surfaces.
- **Do** use JetBrains Mono for every value a developer might see in a terminal: run IDs, costs, step counts, elapsed times, tool names, model identifiers, diff line content.
- **Do** show the pulsing amber dot (`pulse-running`, 1.5s ease-in-out) on status chips for `created`, `in-progress`, and `awaiting` states only — the pulse means the run is consuming the developer's attention now.
- **Do** use amber (#f59e0b) on the primary CTA, the approval banner context, focus rings, and the selected sidebar row's left border — all in one coherent category: "act here."
- **Do** use `text-zinc-500 font-mono` at `text-[10px]` for all secondary run metadata in constrained spaces (sidebar row timestamps, step/cost/elapsed chips in the feed header).

### Don't:

- **Don't** add decorative gradients, glass effects, or drop shadows to panels, sidebars, or cards. The only shadow permitted is the ↓ Follow anchor's `shadow-lg` elevation, and only because it is a temporary floating overlay.
- **Don't** use amber on a completed or static state. Amber means "attention or action needed." Applied to submitted runs, model names, or section labels it loses its signal value.
- **Don't** introduce a border-radius other than 4px (Tailwind `rounded`). Pill shapes (rounded-full) are for the 6×6px status dots only.
- **Don't** use Inter for terminal-style data values (costs, run IDs, step counts). The mono/sans partition must hold; mixing it erodes the visual hierarchy that lets a developer scan a dense feed quickly.
- **Don't** canonize `window.confirm` as the design system's confirmation pattern. The cancel-run flow currently uses a browser-native confirm dialog — a build placeholder, not a design decision.

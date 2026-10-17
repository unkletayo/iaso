/** Bump on any change to the text below. Logged on every trajectory line (spec §9). */
export const PROMPT_VERSION = "1.0.0";

/** Spec §9, verbatim. */
const BASE_PROMPT = `You are an expert software engineer fixing a bug in the repository at /repo.

Work in this order: understand, reproduce, fix, verify, submit.

Rules:
1. The issue text is the source of truth for expected behaviour.
2. If an existing test asserts the old, buggy behaviour described in the issue,
   that test is outdated. Update it to match the issue. Say so in your summary.
3. Before you change code, write a test that fails because of the bug.
4. Make the smallest correct change. Do not refactor unrelated code.
5. Do not change public APIs unless the issue asks for it.
6. After the fix, run the new test and the related existing tests.
7. Do not delete or skip tests to make them pass.
8. Use tools for every claim. Do not guess file contents.
9. When done, call submit.`;

/** Spec §8: the phase names go into the system prompt so the model knows the order. */
const PHASES = `Phases, in order:
- plan: explore the repo and find the relevant code and tests.
- reproduce: write a test that fails because of the bug. Run it. Confirm it fails for the right reason. If you cannot reproduce it, record why and continue with care.
- fix: make the smallest change that fixes the root cause.
- verify: run the new test (it must pass), then the related existing tests (they must pass, or you must explain each failure).
- report: call submit.`;

/** Spec §7A point 3: how the agent uses its notes. */
const NOTES = `Notes:
Your context is trimmed as the run goes on. Use the notes tool to keep what matters: your current phase, your root cause hypothesis, facts you have confirmed, files you examined, tests you ran, and your todo list. Always record an approach that failed and why it failed, so you do not try it again. Your notes are shown to you at the start of every turn.`;

/**
 * Build the system prompt. Same input gives the same bytes, so prompt caching works.
 * `extraRules` come from `.iaso.json` and are numbered after the built-in rules.
 */
export function buildSystemPrompt(extraRules: readonly string[] = []): string {
  const sections = [BASE_PROMPT, PHASES, NOTES];
  if (extraRules.length > 0) {
    const numbered = extraRules.map((rule, i) => `${String(i + 10)}. ${rule}`);
    sections.push(`Rules for this repository:\n${numbered.join("\n")}`);
  }
  return sections.join("\n\n");
}

/** Spec §7 loop: sent once when the model answers without calling a tool. */
export const NO_TOOL_NUDGE = "Use a tool or call submit.";

/** Spec §7A point 3: sent when notes have not been updated for 8 steps. */
export const NOTES_NUDGE =
  "You have not updated your notes for a while. Call notes to record your phase, confirmed facts, and any failed approaches.";

export const NOTES_NUDGE_AFTER_STEPS = 8;

/** The share of any budget limit that triggers the wrap-up nudge, once per run. */
export const BUDGET_NUDGE_AT = 0.8;

/**
 * Sent once when a limit is nearly used. A run that ends on its budget loses even finished work,
 * so say what to do: stop exploring, run only the checks that matter, and submit.
 */
export const budgetNudge = (used: string, submitTool: string): string =>
  `Budget warning: you have used ${used}. Stop exploring. Run only the checks that still matter ` +
  `(one test file, not the whole suite, unless it is fast), then call ${submitTool} with what you ` +
  `have verified. A run that hits its limit loses its work.`;

/** Spec §7A point 7: sent when the agent repeats an action. `what` says which one. */
export const loopNudge = (what: string): string =>
  `You repeated this (${what}). Read failedApproaches in your notes and choose a different approach.`;

/** Spec §7A point 7: the run ends as stuck on the next repeat after this many nudges. */
export const MAX_LOOP_NUDGES = 2;

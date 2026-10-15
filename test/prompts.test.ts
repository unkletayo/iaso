import { describe, expect, it } from "vitest";
import {
  NOTES_NUDGE_AFTER_STEPS,
  NO_TOOL_NUDGE,
  PROMPT_VERSION,
  buildSystemPrompt,
} from "../src/agent/prompts.js";

describe("system prompt", () => {
  const prompt = buildSystemPrompt();

  it("is versioned 1.0.0", () => {
    expect(PROMPT_VERSION).toBe("1.0.0");
  });

  it("contains the nine spec rules, including the two about outdated tests", () => {
    expect(prompt).toContain(
      "You are an expert software engineer fixing a bug in the repository at /repo.",
    );
    expect(prompt).toContain("Work in this order: understand, reproduce, fix, verify, submit.");
    expect(prompt).toContain("1. The issue text is the source of truth for expected behaviour.");
    expect(prompt).toContain(
      "that test is outdated. Update it to match the issue. Say so in your summary.",
    );
    expect(prompt).toContain("7. Do not delete or skip tests to make them pass.");
    expect(prompt).toContain("9. When done, call submit.");
  });

  it("names the phases and explains the notes tool", () => {
    for (const phase of ["plan", "reproduce", "fix", "verify", "report"]) {
      expect(prompt).toContain(`- ${phase}:`);
    }
    expect(prompt).toContain("notes tool");
    expect(prompt).toContain("failed");
  });

  it("is byte-for-byte the same on every call", () => {
    expect(buildSystemPrompt()).toBe(prompt);
    expect(buildSystemPrompt(["a"])).toBe(buildSystemPrompt(["a"]));
  });

  it("appends repo rules from config, numbered after the built-in nine", () => {
    const withRules = buildSystemPrompt(["Run npm run lint before submit", "Use tabs"]);
    expect(withRules.startsWith(prompt)).toBe(true);
    expect(withRules).toContain("10. Run npm run lint before submit");
    expect(withRules).toContain("11. Use tabs");
  });

  it("exposes the nudge texts", () => {
    expect(NO_TOOL_NUDGE).toBe("Use a tool or call submit.");
    expect(NOTES_NUDGE_AFTER_STEPS).toBe(8);
  });
});

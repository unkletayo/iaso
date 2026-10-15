import { describe, expect, it } from "vitest";
import { applyStaleness, outdatedMarker, sameContentMarker } from "../src/context/staleness.js";
import type { Message } from "../src/providers/types.js";

/** One loop step: an assistant tool call and the user message holding its result. */
function step(
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name, input }] },
    { role: "user", content: [{ type: "tool_result", id, output, isError }] },
  ];
}

const read = (id: string, path: string, output: string, extra: Record<string, unknown> = {}) =>
  step(id, "read_file", { path, ...extra }, output);
const edit = (id: string, path: string, isError = false) =>
  step(
    id,
    "edit_file",
    { path, oldText: "a", newText: "b" },
    isError ? "no match" : "Edited",
    isError,
  );

function outputs(messages: Message[]): string[] {
  return messages.flatMap((m) =>
    m.content.flatMap((b) => (b.type === "tool_result" ? [b.output] : [])),
  );
}

describe("applyStaleness", () => {
  it("marks an earlier read outdated once the file is edited", () => {
    const history = [...read("r1", "src/a.js", "OLD CONTENT"), ...edit("e1", "src/a.js")];
    const res = applyStaleness(history);
    expect(res.changed).toBe(true);
    expect(outputs(res.messages)).toEqual([outdatedMarker(2), "Edited"]);
  });

  it("keeps a read made after the edit", () => {
    const history = [
      ...read("r1", "a.js", "OLD"),
      ...edit("e1", "a.js"),
      ...read("r2", "a.js", "NEW"),
    ];
    expect(outputs(applyStaleness(history).messages)).toEqual([outdatedMarker(2), "Edited", "NEW"]);
  });

  it("treats relative and absolute paths as the same file", () => {
    const history = [...read("r1", "/repo/src/a.js", "OLD"), ...edit("e1", "./src/a.js")];
    expect(outputs(applyStaleness(history).messages)[0]).toBe(outdatedMarker(2));
  });

  it("does not touch reads of other files", () => {
    const history = [...read("r1", "b.js", "B"), ...edit("e1", "a.js")];
    const res = applyStaleness(history);
    expect(res.changed).toBe(false);
    expect(outputs(res.messages)).toEqual(["B", "Edited"]);
  });

  it("ignores failed edits: the file did not change", () => {
    const history = [...read("r1", "a.js", "A"), ...edit("e1", "a.js", true)];
    expect(applyStaleness(history).changed).toBe(false);
  });

  it("replaces the older copy of an identical read with a pointer to the newer one", () => {
    const history = [...read("r1", "a.js", "SAME"), ...read("r2", "a.js", "SAME")];
    expect(outputs(applyStaleness(history).messages)).toEqual([sameContentMarker(2), "SAME"]);
  });

  it("keeps both copies when the same range returned different content", () => {
    const history = [...read("r1", "a.js", "ONE"), ...read("r2", "a.js", "TWO")];
    expect(applyStaleness(history).changed).toBe(false);
  });

  it("keeps both when the line ranges differ", () => {
    const history = [
      ...read("r1", "a.js", "X", { startLine: 1, endLine: 10 }),
      ...read("r2", "a.js", "X", { startLine: 11, endLine: 20 }),
    ];
    expect(applyStaleness(history).changed).toBe(false);
  });

  it("prefers outdated over same-content when an edit follows both reads", () => {
    const history = [...read("r1", "a.js", "S"), ...read("r2", "a.js", "S"), ...edit("e1", "a.js")];
    expect(outputs(applyStaleness(history).messages)).toEqual([
      outdatedMarker(3),
      outdatedMarker(3),
      "Edited",
    ]);
  });

  it("skips failed reads and paths outside /repo", () => {
    const history = [
      ...step("r1", "read_file", { path: "a.js" }, "error", true),
      ...step("r2", "read_file", { path: "../etc/passwd" }, "x"),
      ...step("r3", "read_file", { path: "../etc/passwd" }, "x"),
      ...edit("e1", "a.js"),
    ];
    expect(applyStaleness(history).changed).toBe(false);
  });

  it("does not mutate its input and is idempotent", () => {
    const history = [...read("r1", "a.js", "OLD"), ...edit("e1", "a.js")];
    const snapshot = structuredClone(history);
    const once = applyStaleness(history);
    expect(history).toEqual(snapshot);
    const twice = applyStaleness(once.messages);
    expect(twice.changed).toBe(false);
    expect(twice.messages).toEqual(once.messages);
  });

  it("numbers steps from firstStep when older history was removed", () => {
    const history = [...read("r1", "a.js", "OLD"), ...edit("e1", "a.js")];
    expect(outputs(applyStaleness(history, 10).messages)[0]).toBe(outdatedMarker(11));
  });

  it("leaves other tools and text alone", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      ...step("b1", "bash", { cmd: "ls" }, "a.js"),
    ];
    const res = applyStaleness(history);
    expect(res.changed).toBe(false);
    expect(res.messages).toEqual(history);
  });
});

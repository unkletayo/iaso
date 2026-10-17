import { describe, expect, it } from "vitest";
import { type FieldKinds, repairInput } from "../src/tools/repair.js";
import { parseToolInput } from "../src/tools/schema.js";
import { submitPlanDefinition } from "../src/tools/submit-plan.js";

const kinds: FieldKinds = { a: "string", list: "array", other: "array", note: "string" };

/** The call Haiku sent: every later parameter pasted into the first array as XML-style tags. */
const glitched = {
  rootCauseHypothesis: "There is no clock widget.",
  filesToChange:
    '[{"path":"src/lib/catalog.js","change":"Add a clock entry."},{"path":"src/lib/fit.js","change":"Add clock to DROP_ORDER."}]</filesToChange>\n' +
    "<testPlan>Write testClock first and confirm it fails.</testPlan>\n" +
    '<steps>["Write testClock.","Register clock."]</steps>\n' +
    '<risks>["config may not be in scope."]',
};

describe("repairInput", () => {
  it("parses JSON written as a string where an array belongs", () => {
    expect(repairInput({ list: '["x","y"]' }, kinds)).toEqual({ list: ["x", "y"] });
  });

  it("leaves a string field, a valid call and a non-object alone", () => {
    expect(repairInput({ a: '["x"]' }, kinds)).toEqual({ a: '["x"]' });
    expect(repairInput({ list: ["x"] }, kinds)).toEqual({ list: ["x"] });
    expect(repairInput("{oops", kinds)).toBe("{oops");
  });

  it("splits parameters pasted into one another, closing tag or not", () => {
    const out = repairInput({ list: '["x"]</list>\n<note>hello</note>\n<other>["y"]' }, kinds);
    expect(out).toEqual({ list: ["x"], note: "hello", other: ["y"] });
  });

  it("never replaces a field the model also sent properly", () => {
    const out = repairInput({ list: '["x"]</list><note>pasted</note>', note: "real" }, kinds);
    expect(out).toEqual({ list: ["x"], note: "real" });
  });

  it("keeps text it cannot parse, so validation still reports it", () => {
    expect(repairInput({ list: "not json" }, kinds)).toEqual({ list: "not json" });
  });
});

describe("parseToolInput with a repairable call", () => {
  it("accepts the glitched submit_plan call as the plan the model meant", () => {
    const res = parseToolInput(submitPlanDefinition, glitched);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.filesToChange.map((f) => f.path)).toEqual([
        "src/lib/catalog.js",
        "src/lib/fit.js",
      ]);
      expect(res.value.testPlan).toBe("Write testClock first and confirm it fails.");
      expect(res.value.steps).toEqual(["Write testClock.", "Register clock."]);
      expect(res.value.risks).toEqual(["config may not be in scope."]);
    }
  });

  it("still rejects a call that stays invalid after repair, with the original error", () => {
    const res = parseToolInput(submitPlanDefinition, { ...glitched, filesToChange: "[1,2]" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("filesToChange");
  });
});

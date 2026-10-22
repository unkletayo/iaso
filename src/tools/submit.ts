import { z } from "zod";
import { type Tool, defineTool } from "./schema.js";

export const submitDefinition = defineTool({
  name: "submit",
  description:
    "Finish the run. Call it once, when the failing test passes, the rest of the suite still " +
    "passes, and your fix is minimal. summary: what the bug was and what you changed. " +
    "prTitle: one line, under 72 characters, that describes the change you made (not the bug " +
    "report's title). prSummary: a short paragraph for a maintainer who has not seen this run: " +
    "what changed and why. Do not mention steps, tools or your notes. " +
    "assumptions: every place the issue did not say what the behaviour should be and you chose " +
    "(wording of a message, which inputs raise, exact output format). Use [] only if the issue " +
    "settled every behaviour you changed. " +
    "testsAdded: paths of the test files or test names you added. " +
    "confidence: high only if the issue fixes the expected behaviour and you checked it.",
  input: z.strictObject({
    summary: z.string().min(1),
    prTitle: z.string().min(1).max(100),
    prSummary: z.string().min(1),
    assumptions: z.array(z.string().min(1)).default([]),
    testsAdded: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
  }),
});

export const submitTool: Tool<typeof submitDefinition.input> = {
  definition: submitDefinition,
  run(input, { run, step }) {
    if (!run)
      return Promise.resolve({ output: "submit is not available in this run.", isError: true });
    if (run.submission) {
      return Promise.resolve({ output: "Already submitted.", isError: true });
    }
    run.submission = { ...input, step };
    return Promise.resolve({ output: "Submitted. The run is ending.", isError: false });
  },
};

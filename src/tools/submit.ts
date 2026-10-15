import { z } from "zod";
import { type Tool, defineTool } from "./schema.js";

export const submitDefinition = defineTool({
  name: "submit",
  description:
    "Finish the run. Call it once, when the failing test passes, the rest of the suite still " +
    "passes, and your fix is minimal. summary: what the bug was and what you changed. " +
    "testsAdded: paths of the test files or test names you added.",
  input: z.strictObject({
    summary: z.string().min(1),
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

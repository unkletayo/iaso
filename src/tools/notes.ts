import { isEmptyPatch, mergeTaskState, taskStatePatchSchema } from "../context/state.js";
import { type Tool, defineTool } from "./schema.js";

export const notesDefinition = defineTool({
  name: "notes",
  description:
    "Update your task notes. Send only the fields you want to change. phase, rootCauseHypothesis " +
    "and todo are replaced; confirmedFacts, filesExamined, failedApproaches and testsRun are added " +
    "to. Record every failed approach with why it failed: the notes outlive old steps, so you will " +
    "not retry it. The step number is added for you.",
  input: taskStatePatchSchema,
});

export const notesTool: Tool<typeof notesDefinition.input> = {
  definition: notesDefinition,
  run(patch, { run, step }) {
    if (!run)
      return Promise.resolve({ output: "notes is not available in this run.", isError: true });
    if (isEmptyPatch(patch)) {
      return Promise.resolve({
        output: "Nothing to update: send at least one field.",
        isError: true,
      });
    }
    run.task = mergeTaskState(run.task, patch, step);
    run.lastNotesStep = step;
    return Promise.resolve({ output: `Notes updated (step ${String(step)}).`, isError: false });
  },
};

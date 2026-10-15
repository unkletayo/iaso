import { z } from "zod";
import { resolveRepoPath } from "./paths.js";
import { type Tool, type ToolResult, defineTool } from "./schema.js";

export const editFileDefinition = defineTool({
  name: "edit_file",
  description:
    "Edit a file inside /repo by exact string replacement. oldText must match exactly one place " +
    "in the file (include enough surrounding lines to make it unique); it is replaced by newText. " +
    "To create a new file, pass an empty oldText and a path that does not exist yet.",
  input: z.strictObject({
    path: z.string().min(1),
    oldText: z.string(),
    newText: z.string(),
  }),
});

const fail = (output: string): ToolResult => ({ output, isError: true });

/** Quote for POSIX sh: wrap in single quotes and escape embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    // Advance by 1, not by the needle length: overlapping positions are ambiguous edits too.
    at = haystack.indexOf(needle, at + 1)
  ) {
    count += 1;
  }
  return count;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

export const editFileTool: Tool<typeof editFileDefinition.input> = {
  definition: editFileDefinition,
  async run({ path, oldText, newText }, { sandbox }) {
    const resolved = resolveRepoPath(path);

    if (oldText === "") {
      const exists = await sandbox.exec(`test -e ${shellQuote(resolved)}`);
      if (exists.exitCode === 0) {
        return fail(
          `${resolved} already exists. To change it, pass the exact oldText to replace. ` +
            "An empty oldText only creates new files.",
        );
      }
      await sandbox.writeFile(resolved, newText);
      return { output: `Created ${resolved}.`, isError: false };
    }

    if (oldText === newText) return fail("oldText and newText are identical: nothing to change.");

    const content = await sandbox.readFile(resolved);
    const matches = countOccurrences(content, oldText);

    if (matches === 0) {
      const crlf = content.includes("\r\n") && !oldText.includes("\r");
      const hint = crlf
        ? " The file uses Windows line endings (\\r\\n); include \\r in oldText where lines end."
        : " Check whitespace and indentation, and re-read the file for its current content.";
      return fail(`oldText was not found in ${resolved} (0 matches).${hint}`);
    }
    if (matches > 1) {
      return fail(
        `oldText matches ${String(matches)} places in ${resolved}. ` +
          "Include more surrounding lines so it matches exactly one place.",
      );
    }

    const at = content.indexOf(oldText);
    // Slice instead of String.replace so "$&" and similar in newText stay literal.
    await sandbox.writeFile(
      resolved,
      content.slice(0, at) + newText + content.slice(at + oldText.length),
    );
    return {
      output: `Edited ${resolved}: replaced 1 occurrence starting at line ${String(lineNumberAt(content, at))}.`,
      isError: false,
    };
  },
};

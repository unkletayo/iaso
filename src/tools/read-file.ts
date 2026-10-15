import { z } from "zod";
import { resolveRepoPath } from "./paths.js";
import { type Tool, type ToolResult, defineTool } from "./schema.js";

/** Spec §5: at most 400 lines per call. */
export const MAX_READ_LINES = 400;

export const readFileDefinition = defineTool({
  name: "read_file",
  description:
    "Read a file inside /repo with line numbers. Returns at most 400 lines per call: use " +
    "startLine and endLine (1-based, inclusive) to read a range or to continue a long file.",
  input: z.strictObject({
    path: z.string().min(1),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
});

const fail = (output: string): ToolResult => ({ output, isError: true });

/** Split into lines the way editors count them: a trailing newline does not add a line. */
function toLines(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export const readFileTool: Tool<typeof readFileDefinition.input> = {
  definition: readFileDefinition,
  async run({ path, startLine, endLine }, { sandbox }) {
    const resolved = resolveRepoPath(path);
    const content = await sandbox.readFile(resolved);

    if (content.includes("\0")) {
      return fail(`${resolved} looks like a binary file; it cannot be shown as text.`);
    }
    if (content === "") return { output: `${resolved} is empty.`, isError: false };

    const lines = toLines(content);
    const total = lines.length;
    const start = startLine ?? 1;

    if (start > total) {
      return fail(
        `startLine ${String(start)} is past the end: ${resolved} has ${String(total)} lines.`,
      );
    }
    if (endLine !== undefined && endLine < start) {
      return fail(`endLine ${String(endLine)} is before startLine ${String(start)}.`);
    }

    const wanted = endLine ?? total;
    const end = Math.min(wanted, total, start + MAX_READ_LINES - 1);
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width)}\t${line}`)
      .join("\n");

    const header = `${resolved} (lines ${String(start)}-${String(end)} of ${String(total)})`;
    let footer = "";
    if (end < total) {
      const limited =
        end < wanted ? ` Output is limited to ${String(MAX_READ_LINES)} lines per call.` : "";
      footer = `\n[${String(total - end)} more lines.${limited} Use startLine=${String(end + 1)} to continue.]`;
    }
    return { output: `${header}\n${body}${footer}`, isError: false };
  },
};

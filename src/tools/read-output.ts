import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAX_READ_LINES } from "./read-file.js";
import { type Tool, defineTool } from "./schema.js";

/** Where the loop keeps the full text of outputs it shortened (spec §7A point 4). */
export interface OutputStore {
  save(step: number, call: number, raw: string): Promise<void>;
  load(step: number, call: number): Promise<string | undefined>;
}

/** One file per tool call: `<dir>/<step>-<call>.txt`, for example `runs/<runId>/outputs/7-1.txt`. */
export class FileOutputStore implements OutputStore {
  constructor(private readonly dir: string) {}

  private file(step: number, call: number): string {
    return join(this.dir, `${String(step)}-${String(call)}.txt`);
  }

  async save(step: number, call: number, raw: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(step, call), raw, "utf8");
  }

  async load(step: number, call: number): Promise<string | undefined> {
    try {
      return await readFile(this.file(step, call), "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
      throw err;
    }
  }
}

export const readOutputDefinition = defineTool({
  name: "read_output",
  description:
    "Read the full, unshortened output of an earlier tool call. Use it only when a result was " +
    "marked as shortened and you need the part that was left out. Pass the step number from the " +
    "marker; call is the 1-based position of the tool call within that step (default 1). " +
    "Returns at most 400 lines per call: use startLine and endLine to page.",
  input: z.strictObject({
    step: z.number().int().min(1),
    call: z.number().int().min(1).optional(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
});

/** The tool needs the store, so it is built per run instead of living on `ToolContext`. */
export function makeReadOutputTool(store: OutputStore): Tool<typeof readOutputDefinition.input> {
  return {
    definition: readOutputDefinition,
    async run({ step, call = 1, startLine = 1, endLine }) {
      const raw = await store.load(step, call);
      if (raw === undefined) {
        return {
          output:
            `No saved output for step ${String(step)}, call ${String(call)}. ` +
            "Only outputs that were shortened are saved.",
          isError: true,
        };
      }
      const lines = raw.split("\n");
      if (raw.endsWith("\n")) lines.pop();
      if (startLine > lines.length) {
        return {
          output: `startLine ${String(startLine)} is past the end: the output has ${String(lines.length)} lines.`,
          isError: true,
        };
      }
      const end = Math.min(endLine ?? lines.length, lines.length, startLine + MAX_READ_LINES - 1);
      if (end < startLine) {
        return {
          output: `endLine ${String(end)} is before startLine ${String(startLine)}.`,
          isError: true,
        };
      }
      const width = String(end).length;
      const body = lines
        .slice(startLine - 1, end)
        .map((l, i) => `${String(startLine + i).padStart(width)}\t${l}`)
        .join("\n");
      const more = lines.length - end;
      const footer =
        more > 0
          ? `\n[${String(more)} more lines. Use startLine=${String(end + 1)} to continue.]`
          : "";
      return {
        output: `step ${String(step)}, call ${String(call)} (lines ${String(startLine)}-${String(end)} of ${String(lines.length)})\n${body}${footer}`,
        isError: false,
      };
    },
  };
}

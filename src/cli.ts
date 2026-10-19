#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerBench } from "./commands/bench.js";
import { registerModels } from "./commands/models.js";
import { registerReplay } from "./commands/replay.js";
import { registerRun } from "./commands/run.js";

export const VERSION = "0.0.1";

export function buildProgram(): Command {
  const program = new Command()
    .name("iaso")
    .description("Iaso: a minimal coding agent that heals broken code.")
    .version(VERSION);

  registerRun(program);
  registerReplay(program);
  registerBench(program);
  registerModels(program);
  return program;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    await buildProgram().parseAsync([...argv]);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = await main(process.argv);
}

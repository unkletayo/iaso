import type { Command } from "commander";
import { createWebServer } from "../web/server.js";

const DEFAULT_PORT = 4321;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RUNS_DIR = "runs";

export function registerWeb(program: Command): void {
  program
    .command("web")
    .description("Start the Iaso web UI")
    .option("--port <n>", "port to listen on", String(DEFAULT_PORT))
    .option("--host <host>", "host to bind", DEFAULT_HOST)
    .option("--runs <dir>", "runs directory", DEFAULT_RUNS_DIR)
    .action(async (opts: { port: string; host: string; runs: string }) => {
      const port = Number(opts.port);
      const server = await createWebServer({
        port,
        host: opts.host,
        runsDir: opts.runs,
      });
      await server.listen({ port, host: opts.host });
      console.log(`Iaso UI: http://${opts.host}:${String(port)}`);
    });
}

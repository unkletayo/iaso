import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import type { WebSocket } from "ws";
import { loadCatalogue } from "../models.js";
import { findIssues } from "../oss/find.js";
import type { ServeEvent } from "../commands/serve.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const UI_DIST = fileURLToPath(new URL("../../ui/dist", import.meta.url));

/** Reads a file from the run directory, returning null if missing. */
async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Returns the timestamp from a run ID, e.g. `20261118T142300-ab12` → epoch ms. */
function runIdToTimestamp(runId: string): number {
  const match = /^(\d{8}T\d{6})/.exec(runId);
  if (!match?.[1]) return 0;
  const s = match[1];
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  return new Date(iso).getTime() || 0;
}

// ── Active run registry ───────────────────────────────────────────────────────

interface ActiveRun {
  runId: string;
  model: string;
  events: ServeEvent[];
  status: string;
  clients: Set<WebSocket>;
  stdin: NodeJS.WritableStream;
}

const activeRuns = new Map<string, ActiveRun>();

// ── Create server ─────────────────────────────────────────────────────────────

export interface WebServerOptions {
  runsDir: string;
  port: number;
  host: string;
}

export async function createWebServer(opts: WebServerOptions) {
  const fastify = Fastify({ logger: false });

  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyWebsocket);

  // Serve UI static files in production
  if (existsSync(UI_DIST)) {
    await fastify.register(fastifyStatic, {
      root: UI_DIST,
      prefix: "/",
      decorateReply: true,
    });
  }

  // ── GET /api/runs ─────────────────────────────────────────────────────────

  fastify.get("/api/runs", async () => {
    const runsRoot = resolve(opts.runsDir);
    let entries: string[] = [];
    try {
      entries = await readdir(runsRoot);
    } catch {
      return [];
    }

    const results = await Promise.all(
      entries.map(async (name) => {
        const runDir = join(runsRoot, name);
        const raw = await tryRead(join(runDir, "run.json"));
        if (!raw) return null;
        try {
          const info = JSON.parse(raw) as {
            runId: string;
            status: string;
            model: string;
            steps: number;
            costUsd: number;
            elapsedMs: number;
            issueTitle?: string;
            source?: { label: string; issueUrl?: string; commit?: string };
          };
          return {
            runId: info.runId,
            status: info.status,
            model: info.model,
            steps: info.steps,
            costUsd: info.costUsd,
            elapsedMs: info.elapsedMs,
            issueTitle: info.issueTitle,
            source: info.source,
            startedAt: runIdToTimestamp(info.runId),
          };
        } catch {
          return null;
        }
      }),
    );

    return results.filter(Boolean).sort((a, b) => (b?.startedAt ?? 0) - (a?.startedAt ?? 0));
  });

  // ── GET /api/runs/:id ─────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const { id } = req.params;
    const runDir = join(resolve(opts.runsDir), id);

    const [runInfoRaw, report, diff, trajectoryRaw] = await Promise.all([
      tryRead(join(runDir, "run.json")),
      tryRead(join(runDir, "report.md")),
      tryRead(join(runDir, "patch.diff")),
      tryRead(join(runDir, "trajectory.jsonl")),
    ]);

    if (!runInfoRaw) {
      await reply.code(404).send({ error: "Run not found" });
      return;
    }

    const runInfo = JSON.parse(runInfoRaw) as {
      runId: string;
      status: string;
      model: string;
      steps: number;
      costUsd: number;
      elapsedMs: number;
      issueTitle?: string;
      source?: { label: string; issueUrl?: string; commit?: string };
    };

    let trajectory: ServeEvent[] | null = null;
    if (trajectoryRaw) {
      trajectory = trajectoryRaw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as ServeEvent;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as ServeEvent[];
    }

    return {
      runId: runInfo.runId,
      status: runInfo.status,
      model: runInfo.model,
      steps: runInfo.steps,
      costUsd: runInfo.costUsd,
      elapsedMs: runInfo.elapsedMs,
      issueTitle: runInfo.issueTitle,
      source: runInfo.source,
      startedAt: runIdToTimestamp(runInfo.runId),
      report,
      diff,
      trajectory,
      runInfo: JSON.parse(runInfoRaw) as unknown,
    };
  });

  // ── POST /api/runs ─────────────────────────────────────────────────────────

  fastify.post<{
    Body: {
      github?: string;
      repo?: string;
      issue?: string;
      model?: string;
      maxSteps?: number;
      maxCost?: number;
      maxTime?: number;
      plan?: boolean;
    };
  }>("/api/runs", async (req, reply) => {
    const body = req.body;
    const model = body.model ?? "anthropic:claude-sonnet-5-5";

    // Build CLI args for `iaso serve --stdio`
    const args: string[] = ["serve", "--stdio"];
    if (body.github) args.push("--github", body.github);
    else if (body.repo && body.issue) {
      args.push("--repo", body.repo, "--issue", body.issue);
    } else {
      await reply.code(400).send({ error: "Provide github or repo+issue" });
      return;
    }
    args.push("--model", model);
    args.push("--runs", resolve(opts.runsDir));
    if (body.maxSteps) args.push("--max-steps", String(body.maxSteps));
    if (body.maxCost) args.push("--max-cost", String(body.maxCost));
    if (body.maxTime) args.push("--max-time", String(body.maxTime));
    if (body.plan === false) args.push("--no-plan");

    // Resolve the CLI entry point
    const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    const cliExists = existsSync(cliPath);
    const nodeArgs = cliExists
      ? [cliPath]
      : ["--import", "tsx", fileURLToPath(new URL("../../src/cli.ts", import.meta.url))];

    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // We need a runId — read the first event from the child
    const runId = await new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout! });
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for run.created")),
        30_000,
      );
      rl.once("line", (line) => {
        clearTimeout(timer);
        try {
          const event = JSON.parse(line) as ServeEvent;
          if (event.type === "run.created") {
            resolve(event.run_id);
          } else {
            reject(new Error("First event was not run.created"));
          }
        } catch {
          reject(new Error("Invalid first event"));
        }
        rl.close();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Register active run
    const activeRun: ActiveRun = {
      runId,
      model,
      events: [],
      status: "created",
      clients: new Set(),
      stdin: child.stdin!,
    };
    activeRuns.set(runId, activeRun);

    // Stream remaining events into the registry and fan out to WebSocket clients
    const rl2 = createInterface({ input: child.stdout! });
    rl2.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as ServeEvent;
        activeRun.events.push(event);
        if (event.type === "run.in-progress") activeRun.status = "in-progress";
        if (event.type === "run.awaiting") activeRun.status = "awaiting";
        if (event.type === "run.completed") activeRun.status = "submitted";
        if (event.type === "run.failed") activeRun.status = "failed";
        if (event.type === "run.cancelled") activeRun.status = "cancelled";
        // Fan out to WebSocket clients
        const msg = JSON.stringify(event);
        for (const ws of activeRun.clients) {
          if (ws.readyState === 1) ws.send(msg);
        }
      } catch {
        // ignore malformed
      }
    });

    child.on("close", () => {
      activeRun.clients.forEach((ws) => ws.close());
      activeRuns.delete(runId);
    });

    return { runId, status: "created", model };
  });

  // ── GET /api/models ───────────────────────────────────────────────────────

  fastify.get("/api/models", async () => {
    const catalogue = loadCatalogue();
    return catalogue.models.map((m) => ({
      id: m.id,
      provider: m.provider,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      contextWindow: m.contextWindow,
      toolCalls: m.toolCalls,
    }));
  });

  // ── GET /api/find ─────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      q?: string;
      language?: string;
      label?: string | string[];
      bugs_only?: string;
    };
  }>("/api/find", async (req, reply) => {
    const { q, language, label, bugs_only } = req.query;
    if (!q) {
      await reply.code(400).send({ error: "q is required" });
      return;
    }

    const labels = Array.isArray(label) ? label : label ? [label] : [];
    const token = process.env["GITHUB_TOKEN"];

    try {
      const result = await findIssues({
        token,
        ...(language ? { language } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(bugs_only === "1" ? { bugsOnly: true } : {}),
      });
      return {
        candidates: result.candidates,
        repos: result.repos,
        issues: result.issues,
      };
    } catch (err) {
      await reply.code(500).send({
        error: err instanceof Error ? err.message : "Find failed",
      });
    }
  });

  // ── WS /api/runs/:id/stream ───────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    "/api/runs/:id/stream",
    { websocket: true },
    (socket, req) => {
      const { id } = req.params;
      const run = activeRuns.get(id);

      if (!run) {
        socket.close(1008, "Run not found or not active");
        return;
      }

      run.clients.add(socket);

      // Replay buffered events
      for (const event of run.events) {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(event));
        }
      }

      // Forward control messages from browser to child stdin
      socket.on("message", (data) => {
        try {
          const ctrl = JSON.parse(data.toString());
          run.stdin.write(`${JSON.stringify(ctrl)}\n`);
        } catch {
          // ignore malformed
        }
      });

      socket.on("close", () => {
        run.clients.delete(socket);
      });
    },
  );

  // SPA fallback — send index.html for any non-API route
  if (existsSync(UI_DIST)) {
    fastify.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      await reply.code(404).send({ error: "Not found" });
    });
  }

  return fastify;
}

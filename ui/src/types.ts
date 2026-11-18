// Mirrors src/commands/serve.ts wire format

export type ServePart =
  | { kind: "text"; step: number; delta: string }
  | { kind: "tool_call"; step: number; id: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      step: number;
      id: string;
      name: string;
      output: string;
      error: boolean;
    }
  | { kind: "context"; step: number; type: "compacted" | "loop_detected" | "stuck" };

export interface AwaitRequest {
  id: string;
  name: string;
  input: unknown;
}

export type ServeEvent =
  | { type: "run.created"; run_id: string; status: "created" }
  | { type: "run.in-progress"; run_id: string; status: "in-progress" }
  | { type: "message.part"; run_id: string; part: ServePart }
  | { type: "run.awaiting"; run_id: string; status: "awaiting"; await: AwaitRequest }
  | { type: "run.completed"; run_id: string; status: "completed"; result: PipelineResult }
  | { type: "run.failed"; run_id: string; status: "failed"; message: string }
  | { type: "run.cancelled"; run_id: string; status: "cancelled" };

export type ServeControl =
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string; reason?: string }
  | { kind: "cancel" };

export interface PipelineResult {
  status: string;
  steps: number;
  planSteps: number;
  costUsd: number;
  planCostUsd: number;
  diff: string;
  message?: string;
  plan?: unknown;
  fix?: {
    submission?: {
      summary: string;
      confidence: "low" | "medium" | "high";
      prTitle: string;
      prSummary: string;
      assumptions: string[];
      testsAdded: string[];
    };
    state: {
      testsRun: { cmd: string; result: string; step: number }[];
      failedApproaches: { what: string; whyItFailed: string }[];
    };
  };
}

// API types

export type RunStatus =
  "created" | "in-progress" | "awaiting" | "submitted" | "failed" | "cancelled" | "stuck";

export interface RunSummary {
  runId: string;
  status: RunStatus;
  model: string;
  steps: number;
  costUsd: number;
  elapsedMs: number;
  issueTitle?: string;
  source?: { label: string; issueUrl?: string; commit?: string };
  startedAt: number;
}

export interface RunDetail extends RunSummary {
  report: string | null;
  diff: string | null;
  trajectory: ServeEvent[] | null;
  runInfo: RunInfo | null;
}

export interface RunInfo {
  runId: string;
  model: string;
  status: string;
  steps: number;
  costUsd: number;
  elapsedMs: number;
  issueTitle?: string;
  source?: { label: string; issueUrl?: string; commit?: string };
  summary?: string;
  prTitle?: string;
  prSummary?: string;
  assumptions: string[];
  testsAdded: string[];
  confidence?: "low" | "medium" | "high";
  testsRun: { cmd: string; result: string; step: number }[];
  failedApproaches?: { what: string; whyItFailed: string }[];
  verification?: {
    status: string;
    reproduction: { status: string; tail: string };
    suite: { status: string; tail: string };
  };
  attempts?: {
    kept: number;
    asked: number;
    totalCostUsd: number;
    each: {
      attempt: number;
      model?: string;
      status: string;
      check: string;
      costUsd: number;
      steps: number;
    }[];
  };
}

export interface ModelEntry {
  id: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  toolCalls: boolean;
}

export interface FindCandidate {
  url: string;
  title: string;
  score: number;
  reasons: string[];
  copyleft: boolean;
  licenseUnclear: boolean;
  claim: { warnings: string[] };
}

export interface StartRunRequest {
  github?: string;
  repo?: string;
  issue?: string;
  model: string;
  planModel?: string;
  maxSteps?: number;
  maxCost?: number;
  maxTime?: number;
  plan?: boolean;
}

export interface StartRunResponse {
  runId: string;
  status: "created";
  model: string;
}

// Active run state tracked by the UI
export interface LiveRun {
  runId: string;
  status: RunStatus;
  model: string;
  startedAt: number;
  events: ServeEvent[];
  awaiting: AwaitRequest | null;
  steps: number;
  costUsd: number;
  elapsedMs: number;
  issueTitle?: string;
}

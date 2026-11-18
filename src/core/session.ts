import type { BudgetLimits } from "../config.js";
import type { TaskState } from "../context/state.js";
import type { PhaseSetup, PipelineResult, PlanReviewer } from "../agent/pipeline.js";
import { runPipeline } from "../agent/pipeline.js";
import type { LoopHooks } from "../agent/loop.js";
import type { Sandbox } from "../sandbox/types.js";

export type SessionEvent =
  | { kind: "step_started"; step: number }
  | { kind: "text_delta"; step: number; delta: string }
  | { kind: "tool_call"; step: number; id: string; name: string; input: unknown }
  | { kind: "tool_result"; step: number; id: string; name: string; output: string; error: boolean }
  | { kind: "approval_requested"; step: number; id: string; name: string; input: unknown }
  | { kind: "context_event"; step: number; type: "compacted" | "loop_detected" | "stuck" }
  | { kind: "finished"; result: PipelineResult; verification: Verification; network: NetworkState };

export type SessionControl =
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string; reason?: string }
  | { kind: "cancel" };

export interface ApprovalPolicy {
  default: "auto" | "ask" | "deny";
  rules: Array<{ tool: string; pattern?: string; action: "auto" | "ask" | "deny" }>;
}

export type NetworkState = "enabled" | "disabled";

export interface Verification {
  submitted: boolean;
  phase: TaskState["phase"] | "unknown";
}

export interface SessionOptions {
  fix: PhaseSetup;
  plan?: PhaseSetup;
  compact?: PhaseSetup;
  sandbox: Sandbox;
  issue: string;
  limits: BudgetLimits;
  runDir: string;
  extraRules?: readonly string[];
  usePlan: boolean;
  review?: PlanReviewer;
  approvalPolicy: ApprovalPolicy;
  now?: () => number;
}

export interface Session {
  readonly events: AsyncIterable<SessionEvent>;
  send(control: SessionControl): void;
  start(): Promise<void>;
}

/** Minimal push-queue async iterable. Items pushed before consume are buffered. */
class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()!({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters) waiter({ value: undefined as unknown as T, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function resolveAction(policy: ApprovalPolicy, toolName: string): "auto" | "ask" | "deny" {
  for (const rule of policy.rules) {
    if (rule.tool === toolName) return rule.action;
  }
  return policy.default;
}

export function createSession(opts: SessionOptions): Session {
  const queue = new PushQueue<SessionEvent>();
  const pendingApprovals = new Map<string, (action: "auto" | "deny") => void>();
  let cancelRequested = false;

  const hooks: LoopHooks = {
    onStepStarted: (step) => {
      queue.push({ kind: "step_started", step });
    },
    onText: (step, delta) => {
      queue.push({ kind: "text_delta", step, delta });
    },
    onToolApproval: async (step, call) => {
      if (cancelRequested) return "deny";
      queue.push({ kind: "tool_call", step, id: call.id, name: call.name, input: call.input });
      const action = resolveAction(opts.approvalPolicy, call.name);
      if (action !== "ask") return action;
      queue.push({
        kind: "approval_requested",
        step,
        id: call.id,
        name: call.name,
        input: call.input,
      });
      return new Promise<"auto" | "deny">((resolve) => {
        pendingApprovals.set(call.id, resolve);
      });
    },
    onToolResult: (step, id, name, output, error) => {
      queue.push({ kind: "tool_result", step, id, name, output, error });
    },
    onContextEvent: (step, type) => {
      queue.push({ kind: "context_event", step, type });
    },
  };

  function send(control: SessionControl): void {
    if (control.kind === "cancel") {
      cancelRequested = true;
      for (const resolve of pendingApprovals.values()) resolve("deny");
      pendingApprovals.clear();
    } else if (control.kind === "approve") {
      pendingApprovals.get(control.id)?.("auto");
      pendingApprovals.delete(control.id);
    } else {
      pendingApprovals.get(control.id)?.("deny");
      pendingApprovals.delete(control.id);
    }
  }

  async function start(): Promise<void> {
    try {
      const result = await runPipeline({
        fix: opts.fix,
        ...(opts.plan ? { plan: opts.plan } : {}),
        ...(opts.compact ? { compact: opts.compact } : {}),
        sandbox: opts.sandbox,
        issue: opts.issue,
        limits: opts.limits,
        runDir: opts.runDir,
        ...(opts.extraRules ? { extraRules: opts.extraRules } : {}),
        usePlan: opts.usePlan,
        ...(opts.review ? { review: opts.review } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        hooks,
        cancel: () => cancelRequested,
      });

      const verification: Verification = {
        submitted: result.status === "submitted",
        phase: result.fix?.state.phase ?? "unknown",
      };
      queue.push({ kind: "finished", result, verification, network: "enabled" });
    } finally {
      queue.close();
    }
  }

  return { events: queue, send, start };
}

import { useState, useCallback, useEffect, useReducer } from "react";
import { api } from "./api";
import type {
  RunSummary,
  LiveRun,
  ServeEvent,
  RunStatus,
  AwaitRequest,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { NewRun } from "./pages/NewRun";
import { LiveFeed } from "./pages/LiveFeed";
import { RunDetailPage } from "./pages/RunDetail";
import { useRunStream } from "./hooks/useRunStream";

type View =
  | { kind: "new-run" }
  | { kind: "live"; runId: string }
  | { kind: "detail"; runId: string };

type LiveRunAction =
  | { type: "CREATE"; runId: string; model: string }
  | { type: "EVENT"; runId: string; event: ServeEvent };

const RUNS_POLL_INTERVAL_MS = 10_000;
const COST_PER_STEP_ESTIMATE = 0.001;

function liveRunReducer(state: Map<string, LiveRun>, action: LiveRunAction): Map<string, LiveRun> {
  if (action.type === "CREATE") {
    const next = new Map(state);
    next.set(action.runId, {
      runId: action.runId,
      status: "created",
      model: action.model,
      startedAt: Date.now(),
      events: [],
      awaiting: null,
      steps: 0,
      costUsd: 0,
      elapsedMs: 0,
    });
    return next;
  }

  if (action.type === "EVENT") {
    const run = state.get(action.runId);
    if (!run) return state;
    const next = new Map(state);
    const event = action.event;

    let status: RunStatus = run.status;
    let awaiting: AwaitRequest | null = run.awaiting;
    let steps = run.steps;
    let costUsd = run.costUsd;
    let issueTitle = run.issueTitle;

    if (event.type === "run.in-progress") status = "in-progress";
    if (event.type === "run.awaiting") {
      status = "awaiting";
      awaiting = event.await;
    }
    if (event.type === "run.completed") {
      status = "submitted";
      awaiting = null;
      steps = event.result.steps;
      costUsd = event.result.costUsd;
    }
    if (event.type === "run.failed") {
      status = "failed";
      awaiting = null;
    }
    if (event.type === "run.cancelled") {
      status = "cancelled";
      awaiting = null;
    }
    if (event.type === "message.part" && event.part.kind === "tool_result") {
      steps = event.part.step;
      costUsd = steps * COST_PER_STEP_ESTIMATE;
    }
    // Clear awaiting when we get a tool result for the awaited call
    if (
      event.type === "message.part" &&
      event.part.kind === "tool_result" &&
      awaiting?.id === event.part.id
    ) {
      awaiting = null;
      if (status === "awaiting") status = "in-progress";
    }

    next.set(action.runId, {
      ...run,
      status,
      awaiting,
      steps,
      costUsd,
      issueTitle,
      elapsedMs: Date.now() - run.startedAt,
      events:
        event.type === "message.part" || event.type === "run.in-progress"
          ? [...run.events, event]
          : [...run.events, event],
    });
    return next;
  }

  return state;
}

export function App() {
  const [view, setView] = useState<View>({ kind: "new-run" });
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [liveRunMap, dispatchLive] = useReducer(
    liveRunReducer,
    new Map<string, LiveRun>(),
  );
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);

  // Poll run history
  useEffect(() => {
    function poll() {
      api.runs.list().then(setRuns).catch(() => {});
    }
    poll();
    const id = setInterval(poll, RUNS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Stream active run
  const handleEvent = useCallback(
    (event: ServeEvent) => {
      if (!activeStreamId) return;
      dispatchLive({ type: "EVENT", runId: activeStreamId, event });
      // Auto-navigate to live feed
      if (event.type === "run.in-progress") {
        setView({ kind: "live", runId: activeStreamId });
      }
      // On completion, reload runs and go to detail
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        api.runs.list().then(setRuns).catch(() => {});
        if (event.type === "run.completed") {
          setTimeout(() => {
            setView({ kind: "detail", runId: activeStreamId });
          }, 500);
        }
      }
    },
    [activeStreamId],
  );

  const { send } = useRunStream({
    runId: activeStreamId,
    onEvent: handleEvent,
  });

  function handleRunStarted(runId: string, model: string) {
    dispatchLive({ type: "CREATE", runId, model });
    setActiveStreamId(runId);
    setView({ kind: "live", runId });
  }

  function handleSelectRun(id: string) {
    const liveRun = liveRunMap.get(id);
    if (liveRun && (liveRun.status === "in-progress" || liveRun.status === "awaiting" || liveRun.status === "created")) {
      setView({ kind: "live", runId: id });
    } else {
      setView({ kind: "detail", runId: id });
    }
  }

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "n" || e.key === "N") setView({ kind: "new-run" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const liveRuns = Array.from(liveRunMap.values());
  const selectedRunId =
    view.kind === "live" || view.kind === "detail" ? view.runId : null;

  const activeRun =
    view.kind === "live" ? liveRunMap.get(view.runId) ?? null : null;

  return (
    <div className="flex h-full bg-zinc-950">
      <Sidebar
        runs={runs}
        liveRuns={liveRuns}
        selectedRunId={selectedRunId}
        onSelectRun={handleSelectRun}
        onNewRun={() => setView({ kind: "new-run" })}
      />

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {view.kind === "new-run" && (
          <NewRun
            onRunStarted={(runId) => {
              // We don't have the model here; default to empty string — will be set via event
              handleRunStarted(runId, "");
            }}
          />
        )}
        {view.kind === "live" && activeRun && (
          <LiveFeed run={activeRun} onControl={send} />
        )}
        {view.kind === "live" && !activeRun && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-zinc-500 font-mono">Run not found</p>
          </div>
        )}
        {view.kind === "detail" && <RunDetailPage runId={view.runId} />}
      </main>
    </div>
  );
}

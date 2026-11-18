import { Plus } from "lucide-react";
import type { RunSummary, LiveRun } from "../types";
import { StatusChip } from "./StatusChip";

const MIN_COST_DISPLAY = 0.01;

interface SidebarProps {
  runs: RunSummary[];
  liveRuns: LiveRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onModels: () => void;
}

function formatCost(usd: number): string {
  if (usd < MIN_COST_DISPLAY) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

export function Sidebar({
  runs,
  liveRuns,
  selectedRunId,
  onSelectRun,
  onNewRun,
  onModels,
}: SidebarProps) {
  // Merge live runs with historical runs, deduplicating by runId
  const liveIds = new Set(liveRuns.map((r) => r.runId));
  const historical = runs.filter((r) => !liveIds.has(r.runId));

  const allItems: Array<{ kind: "live"; run: LiveRun } | { kind: "historical"; run: RunSummary }> =
    [
      ...liveRuns.map((r) => ({ kind: "live" as const, run: r })),
      ...historical.map((r) => ({ kind: "historical" as const, run: r })),
    ];

  return (
    <aside className="flex flex-col w-[220px] min-w-[220px] border-r border-zinc-800 bg-zinc-900 h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-semibold text-zinc-100 tracking-tight">iaso</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onModels}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
          >
            Models
          </button>
          <button
            onClick={onNewRun}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
            title="New run (N)"
          >
            <Plus size={13} />
            New run
          </button>
        </div>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <p className="text-xs text-zinc-500">No runs yet</p>
            <button
              onClick={onNewRun}
              className="mt-3 text-xs text-amber-500 hover:text-amber-400 transition-colors"
            >
              Start your first run
            </button>
          </div>
        ) : (
          <ul className="py-1">
            {allItems.map((item) => {
              const id = item.kind === "live" ? item.run.runId : item.run.runId;
              const isSelected = selectedRunId === id;
              const status = item.kind === "live" ? item.run.status : item.run.status;
              const title =
                item.kind === "live"
                  ? (item.run.issueTitle ?? item.run.runId)
                  : (item.run.issueTitle ?? item.run.runId);
              const model = item.kind === "live" ? item.run.model : item.run.model;
              const steps = item.kind === "live" ? item.run.steps : item.run.steps;
              const costUsd = item.kind === "live" ? item.run.costUsd : item.run.costUsd;
              const startedAt = item.kind === "live" ? item.run.startedAt : item.run.startedAt;
              const elapsedMs = item.kind === "live" ? item.run.elapsedMs : item.run.elapsedMs;

              return (
                <li key={id}>
                  <button
                    onClick={() => onSelectRun(id)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-zinc-800 transition-colors border-l-2 ${
                      isSelected ? "border-amber-500 bg-zinc-800/60" : "border-transparent"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <StatusChip status={status} />
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {formatTime(startedAt)}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-200 truncate leading-tight mb-1">{title}</p>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono">
                      <span className="truncate max-w-[70px]">{model.split(":")[1] ?? model}</span>
                      <span>{steps}st</span>
                      <span>{formatCost(costUsd)}</span>
                      <span>{formatElapsed(elapsedMs)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

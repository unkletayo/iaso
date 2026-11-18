import { useEffect, useRef, useState, useCallback } from "react";
import { X } from "lucide-react";
import type { LiveRun, ServeControl } from "../../types";
import { StepCard } from "./StepCard";
import { ApprovalBanner } from "./ApprovalBanner";

interface LiveFeedProps {
  run: LiveRun;
  onControl: (ctrl: ServeControl) => void;
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function LiveFeed({ run, onControl }: LiveFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [elapsed, setElapsed] = useState(Date.now() - run.startedAt);

  // Live elapsed timer
  useEffect(() => {
    if (run.status !== "in-progress" && run.status !== "awaiting") return;
    const id = setInterval(() => setElapsed(Date.now() - run.startedAt), 1000);
    return () => clearInterval(id);
  }, [run.status, run.startedAt]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [run.events.length, autoScroll]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  }

  const handleApprove = useCallback(() => {
    if (run.awaiting) onControl({ kind: "approve", id: run.awaiting.id });
  }, [run.awaiting, onControl]);

  const handleReject = useCallback(() => {
    if (run.awaiting) onControl({ kind: "reject", id: run.awaiting.id });
  }, [run.awaiting, onControl]);

  const handleCancel = useCallback(() => {
    if (window.confirm("Cancel this run?")) {
      onControl({ kind: "cancel" });
    }
  }, [onControl]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "a" || e.key === "A") handleApprove();
      if (e.key === "r" || e.key === "R") handleReject();
      if (e.key === "Escape") handleCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleApprove, handleReject, handleCancel]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-4 px-5 py-2.5 border-b border-zinc-800 bg-zinc-900/80 shrink-0">
        <span className="text-xs font-mono text-zinc-500 truncate max-w-[180px]">{run.runId}</span>
        <span className="text-xs text-zinc-400">
          {run.model.split(":")[1] ?? run.model}
        </span>
        <span className="text-xs font-mono text-zinc-400">{formatElapsed(elapsed)}</span>
        <span className="text-xs font-mono text-zinc-500">step {run.steps}</span>
        <span className="text-xs font-mono text-zinc-500">{formatCost(run.costUsd)}</span>
        <div className="flex-1" />
        <button
          onClick={handleCancel}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors"
        >
          <X size={12} />
          Cancel
        </button>
      </div>

      {/* Approval banner */}
      {run.awaiting && (
        <ApprovalBanner
          awaiting={run.awaiting}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Feed */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2"
      >
        {run.events.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500 pulse-running" />
            Starting sandbox…
          </div>
        )}

        {run.events.map((event, i) => (
          <StepCard key={i} event={event} />
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Follow anchor */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }}
          className="absolute bottom-6 right-6 px-3 py-1.5 bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 rounded shadow-lg hover:bg-zinc-700 transition-colors"
        >
          ↓ Follow
        </button>
      )}
    </div>
  );
}

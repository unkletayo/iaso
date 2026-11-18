import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ServeEvent, ServePart } from "../../types";

const TOOL_INPUT_PREVIEW_LENGTH = 120;

interface StepCardProps {
  event: ServeEvent;
}

export function StepCard({ event }: StepCardProps) {
  if (event.type === "message.part") {
    return <PartCard part={event.part} />;
  }
  if (event.type === "run.in-progress") {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500 pulse-running" />
        Run started
      </div>
    );
  }
  if (event.type === "run.completed") {
    return (
      <div className="flex items-center gap-2 text-xs text-green-400 font-mono">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        Completed — {event.result.steps} steps, ${event.result.costUsd.toFixed(4)}
      </div>
    );
  }
  if (event.type === "run.failed") {
    return (
      <div className="flex items-center gap-2 text-xs text-red-400 font-mono">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        Failed: {event.message}
      </div>
    );
  }
  if (event.type === "run.cancelled") {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
        <span className="inline-block w-2 h-2 rounded-full bg-zinc-600" />
        Cancelled
      </div>
    );
  }
  return null;
}

function PartCard({ part }: { part: ServePart }) {
  if (part.kind === "text") {
    return <TextDelta step={part.step} delta={part.delta} />;
  }
  if (part.kind === "tool_call") {
    return <ToolCallCard part={part} />;
  }
  if (part.kind === "tool_result") {
    return <ToolResultCard part={part} />;
  }
  if (part.kind === "context") {
    return (
      <div className="text-[10px] text-zinc-600 font-mono px-1">
        — {part.type.replace(/_/g, " ")} —
      </div>
    );
  }
  return null;
}

// Text accumulates across consecutive text_delta events by step
function TextDelta({ step, delta }: { step: number; delta: string }) {
  return (
    <div className="text-sm text-zinc-200 font-mono whitespace-pre-wrap leading-relaxed">
      <span className="text-[10px] text-zinc-600 mr-2">#{step}</span>
      {delta}
    </div>
  );
}

function ToolCallCard({ part }: { part: Extract<ServePart, { kind: "tool_call" }> }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(part.input, null, 2);
  const preview = inputStr.slice(0, TOOL_INPUT_PREVIEW_LENGTH);

  return (
    <div className="border border-zinc-800 rounded bg-zinc-900/60 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-zinc-500 shrink-0" />
        )}
        <span className="text-[10px] text-zinc-500 font-mono">#{part.step}</span>
        <span className="text-xs font-mono text-amber-400 font-medium">{part.name}</span>
        {!expanded && (
          <span className="text-xs text-zinc-500 font-mono truncate">
            {preview}
            {inputStr.length > TOOL_INPUT_PREVIEW_LENGTH ? "…" : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3">
          <pre className="text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
            {inputStr}
          </pre>
        </div>
      )}
    </div>
  );
}

function ToolResultCard({ part }: { part: Extract<ServePart, { kind: "tool_result" }> }) {
  const [expanded, setExpanded] = useState(false);
  const preview = part.output.slice(0, TOOL_INPUT_PREVIEW_LENGTH);

  return (
    <div
      className={`border rounded overflow-hidden ${
        part.error ? "border-red-900/50 bg-red-950/20" : "border-zinc-800/50 bg-zinc-900/30"
      }`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-zinc-800/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown size={11} className="text-zinc-600 shrink-0" />
        ) : (
          <ChevronRight size={11} className="text-zinc-600 shrink-0" />
        )}
        <span className="text-[10px] text-zinc-600 font-mono">result</span>
        {part.error && <span className="text-[10px] text-red-400 font-mono">error</span>}
        {!expanded && (
          <span className="text-xs text-zinc-500 font-mono truncate">
            {preview}
            {part.output.length > TOOL_INPUT_PREVIEW_LENGTH ? "…" : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          <pre
            className={`text-xs font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed ${
              part.error ? "text-red-300" : "text-zinc-400"
            }`}
          >
            {part.output}
          </pre>
        </div>
      )}
    </div>
  );
}

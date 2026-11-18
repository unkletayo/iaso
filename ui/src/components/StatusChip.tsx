import type { RunStatus } from "../types";

const STATUS_LABEL: Record<RunStatus, string> = {
  created: "starting",
  "in-progress": "running",
  awaiting: "awaiting",
  submitted: "submitted",
  failed: "failed",
  cancelled: "cancelled",
  stuck: "stuck",
};

const STATUS_COLOR: Record<RunStatus, string> = {
  created: "text-amber-500",
  "in-progress": "text-amber-500",
  awaiting: "text-amber-500",
  submitted: "text-emerald-500",
  failed: "text-red-500",
  cancelled: "text-zinc-500",
  stuck: "text-red-500",
};

const DOT_COLOR: Record<RunStatus, string> = {
  created: "bg-amber-500 pulse-running",
  "in-progress": "bg-amber-500 pulse-running",
  awaiting: "bg-amber-500 pulse-running",
  submitted: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-zinc-600",
  stuck: "bg-red-500",
};

interface StatusChipProps {
  status: RunStatus;
}

export function StatusChip({ status }: StatusChipProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-mono ${STATUS_COLOR[status]}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT_COLOR[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

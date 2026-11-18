import type { AwaitRequest } from "../../types";

const INPUT_PREVIEW_LENGTH = 200;

interface ApprovalBannerProps {
  awaiting: AwaitRequest;
  onApprove: () => void;
  onReject: () => void;
}

export function ApprovalBanner({ awaiting, onApprove, onReject }: ApprovalBannerProps) {
  const inputStr = JSON.stringify(awaiting.input);
  const preview = inputStr.slice(0, INPUT_PREVIEW_LENGTH);

  return (
    <div className="shrink-0 flex items-center gap-4 px-5 py-3 bg-amber-950 border-b border-amber-800/60">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-mono text-amber-400 font-medium">{awaiting.name}</span>
          <span className="text-[10px] text-amber-500/60 font-mono">awaiting approval</span>
        </div>
        <p className="text-xs text-zinc-400 font-mono truncate">
          {preview}
          {inputStr.length > INPUT_PREVIEW_LENGTH ? "…" : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-900/40 border border-green-700/50 text-green-400 text-xs font-medium rounded hover:bg-green-900/60 transition-colors"
        >
          Approve
          <kbd className="text-[10px] text-green-600 font-mono">A</kbd>
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-950/40 border border-red-800/50 text-red-400 text-xs font-medium rounded hover:bg-red-950/60 transition-colors"
        >
          Reject
          <kbd className="text-[10px] text-red-600 font-mono">R</kbd>
        </button>
      </div>
    </div>
  );
}

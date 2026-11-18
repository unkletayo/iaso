import { useEffect, useState } from "react";
import { api } from "../../api";
import type { RunDetail as RunDetailData } from "../../types";
import { DiffView } from "./DiffView";
import { ReportView } from "./ReportView";
import { StepCard } from "../LiveFeed/StepCard";
import { StatusChip } from "../../components/StatusChip";
import type { RunStatus } from "../../types";
import { ChevronDown, ChevronRight } from "lucide-react";

type Tab = "diff" | "report" | "trajectory";

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;

function extractIssueBody(report: string | null): string | null {
  if (!report) return null;
  const match = /## Issue\n\n([\s\S]+?)\n\n##/.exec(report);
  return match?.[1]?.trim() ?? null;
}

function formatElapsed(ms: number): string {
  if (ms < MS_PER_MINUTE) return `${Math.round(ms / MS_PER_SECOND)}s`;
  return `${Math.floor(ms / MS_PER_MINUTE)}m ${Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND)}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

interface RunDetailProps {
  runId: string;
}

export function RunDetailPage({ runId }: RunDetailProps) {
  const [data, setData] = useState<RunDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("diff");
  const [planExpanded, setPlanExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.runs
      .get(runId)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load run");
        setLoading(false);
      });
  }, [runId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-500 font-mono">Loading…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-red-400">{error ?? "Run not found"}</p>
      </div>
    );
  }

  const info = data.runInfo;
  const status = (info?.status ?? data.status) as RunStatus;
  const issueBody = extractIssueBody(data.report);

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left column — 40% — summary */}
      <div className="w-[40%] min-w-[280px] border-r border-zinc-800 overflow-y-auto px-5 py-5 flex flex-col gap-4">
        {/* Status + meta */}
        <div>
          <StatusChip status={status} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-zinc-500">
            <span>{data.model.split(":")[1] ?? data.model}</span>
            <span>{info?.steps ?? data.steps} steps</span>
            <span>{formatCost(info?.costUsd ?? data.costUsd)}</span>
            <span>{formatElapsed(info?.elapsedMs ?? data.elapsedMs)}</span>
          </div>
        </div>

        {/* Issue title + body */}
        {data.issueTitle && (
          <div>
            <p className="text-xs text-zinc-500 mb-0.5">Issue</p>
            <p className="text-sm text-zinc-200 leading-snug">{data.issueTitle}</p>
            {issueBody && (
              <p className="mt-1 text-xs text-zinc-500 leading-relaxed line-clamp-3">{issueBody}</p>
            )}
          </div>
        )}

        {/* Source */}
        {data.source?.issueUrl && (
          <a
            href={data.source.issueUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-mono text-amber-500/80 hover:text-amber-400 truncate"
          >
            {data.source.issueUrl}
          </a>
        )}

        {/* Summary */}
        {info?.summary && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">Summary</p>
            <p className="text-sm text-zinc-300 leading-relaxed">{info.summary}</p>
            {info.confidence && (
              <span className="mt-1 inline-block text-xs font-mono text-zinc-500">
                confidence: {info.confidence}
              </span>
            )}
          </div>
        )}

        {/* Verification */}
        {info?.verification && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">Verification</p>
            <div className="text-xs font-mono space-y-0.5">
              <div className="flex gap-2">
                <span className="text-zinc-600">repro</span>
                <span
                  className={
                    info.verification.reproduction.status === "pass"
                      ? "text-green-400"
                      : "text-red-400"
                  }
                >
                  {info.verification.reproduction.status}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-zinc-600">suite</span>
                <span
                  className={
                    info.verification.suite.status === "pass" ? "text-green-400" : "text-red-400"
                  }
                >
                  {info.verification.suite.status}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Plan — collapsed by default */}
        {info?.prTitle && (
          <div>
            <button
              onClick={() => setPlanExpanded(!planExpanded)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {planExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Plan / PR
            </button>
            {planExpanded && (
              <div className="mt-2 text-xs font-mono text-zinc-400 space-y-1">
                <p className="text-zinc-200 font-sans">{info.prTitle}</p>
                {info.prSummary && (
                  <p className="text-zinc-400 leading-relaxed">{info.prSummary}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tests added */}
        {info && info.testsAdded.length > 0 && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">Tests added</p>
            <ul className="text-xs font-mono text-zinc-400 space-y-0.5">
              {info.testsAdded.map((t, i) => (
                <li key={i} className="truncate">
                  — {t}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Tests run */}
        {data.runInfo && data.runInfo.testsRun.length > 0 && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">Tests run</p>
            <ul className="text-xs font-mono space-y-0.5">
              {data.runInfo.testsRun.map((t, i) => (
                <li key={i} className="flex gap-2">
                  <span className={t.result === "pass" ? "text-green-500" : "text-red-500"}>
                    {t.result}
                  </span>
                  <span className="text-zinc-500 truncate">{t.cmd}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Failed approaches */}
        {data.runInfo?.failedApproaches && data.runInfo.failedApproaches.length > 0 && (
          <div>
            <p className="text-xs text-zinc-500 mb-1">Failed approaches</p>
            <ul className="text-xs font-mono space-y-1">
              {data.runInfo.failedApproaches.map((a, i) => (
                <li key={i}>
                  <span className="text-zinc-400">{a.what}</span>
                  <span className="text-zinc-600"> — {a.whyItFailed}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Right column — 60% — tabs */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-zinc-800 bg-zinc-900/80 shrink-0">
          {(["diff", "report", "trajectory"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-xs font-medium transition-colors ${
                tab === t
                  ? "text-zinc-100 border-b-2 border-amber-500"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "diff" && <DiffView diff={data.diff ?? ""} />}
          {tab === "report" && <ReportView report={data.report ?? ""} />}
          {tab === "trajectory" && (
            <div className="flex flex-col gap-2">
              {(data.trajectory ?? []).map((event, i) => (
                <StepCard key={i} event={event} />
              ))}
              {!data.trajectory?.length && (
                <p className="text-sm text-zinc-500 py-4 text-center font-mono">
                  No trajectory recorded
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { api } from "../../api";
import type { ModelEntry, FindCandidate, StartRunRequest } from "../../types";
import { Search, GitBranch, FileText, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

type SourceKind = "github" | "local" | "find";

interface NewRunProps {
  onRunStarted: (runId: string) => void;
}

export function NewRun({ onRunStarted }: NewRunProps) {
  const [sourceKind, setSourceKind] = useState<SourceKind>("github");
  const [models, setModels] = useState<ModelEntry[]>([]);

  // source-specific state
  const [githubUrl, setGithubUrl] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [issueFile, setIssueFile] = useState("");

  // find-specific state
  const [findQuery, setFindQuery] = useState("");
  const [findLanguage, setFindLanguage] = useState("");
  const [findLabel, setFindLabel] = useState<string[]>([]);
  const [findResults, setFindResults] = useState<FindCandidate[] | null>(null);
  const [findLoading, setFindLoading] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<FindCandidate | null>(null);

  // run config state
  const [model, setModel] = useState("");
  const [showBudget, setShowBudget] = useState(false);
  const [maxSteps, setMaxSteps] = useState(50);
  const [maxCost, setMaxCost] = useState(2);
  const [maxTime, setMaxTime] = useState(30);
  const [usePlan, setUsePlan] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    api.models
      .list()
      .then((ms) => {
        setModels(ms);
        const defaultModel = ms.find((m) => m.id.includes("sonnet"))?.id ?? ms[0]?.id ?? "";
        setModel(defaultModel);
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const issueConfirmed =
    sourceKind === "github"
      ? githubUrl.trim().startsWith("https://github.com/")
      : sourceKind === "local"
        ? repoPath.trim() !== "" && issueFile.trim() !== ""
        : selectedIssue !== null;

  async function handleFind() {
    if (!findQuery.trim()) return;
    setFindLoading(true);
    setFindError(null);
    setFindResults(null);
    try {
      const res = await api.find.search({
        query: findQuery,
        language: findLanguage || undefined,
        label: findLabel.length > 0 ? findLabel : undefined,
      });
      setFindResults(res.candidates);
    } catch (err) {
      setFindError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setFindLoading(false);
    }
  }

  async function handleStartRun() {
    setStarting(true);
    setStartError(null);
    try {
      const req: StartRunRequest = {
        model,
        maxSteps,
        maxCost,
        maxTime,
        plan: usePlan,
      };
      if (sourceKind === "github") {
        req.github = githubUrl;
      } else if (sourceKind === "local") {
        req.repo = repoPath;
        req.issue = issueFile;
      } else if (selectedIssue) {
        req.github = selectedIssue.url;
      }
      const res = await api.runs.start(req);
      onRunStarted(res.runId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setStarting(false);
    }
  }

  const providerGroups = groupByProvider(models);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-lg font-semibold text-zinc-100 mb-1">New run</h1>
        <p className="text-sm text-zinc-500 mb-8">Start a new Iaso agent session</p>

        {/* Source selector */}
        <div className="mb-8">
          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-3 block">
            How do you want to start?
          </label>
          <div className="flex flex-col gap-2">
            {(
              [
                {
                  kind: "github" as const,
                  icon: <GitBranch size={14} />,
                  label: "GitHub issue URL",
                  desc: "Paste a specific issue link",
                },
                {
                  kind: "local" as const,
                  icon: <FileText size={14} />,
                  label: "Local repo + issue",
                  desc: "Repo path + issue file on disk",
                },
                {
                  kind: "find" as const,
                  icon: <Search size={14} />,
                  label: "Find me an issue",
                  desc: "Search GitHub for something worth fixing",
                },
              ] as const
            ).map(({ kind, icon, label, desc }) => (
              <label
                key={kind}
                className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                  sourceKind === kind
                    ? "border-amber-500/50 bg-amber-500/5"
                    : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/50"
                }`}
              >
                <input
                  type="radio"
                  name="source"
                  value={kind}
                  checked={sourceKind === kind}
                  onChange={() => {
                    setSourceKind(kind);
                    setSelectedIssue(null);
                    setFindResults(null);
                  }}
                  className="mt-0.5 accent-amber-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <span className="text-zinc-400">{icon}</span>
                    {label}
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Source-specific inputs */}
        {sourceKind === "github" && (
          <div className="mb-8">
            <label className="text-xs font-medium text-zinc-400 mb-1.5 block">
              GitHub issue URL
            </label>
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/issues/123"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 font-mono"
            />
          </div>
        )}

        {sourceKind === "local" && (
          <div className="mb-8 flex flex-col gap-4">
            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1.5 block">
                Repository path
              </label>
              <input
                type="text"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/path/to/repo"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1.5 block">
                Issue file path
              </label>
              <input
                type="text"
                value={issueFile}
                onChange={(e) => setIssueFile(e.target.value)}
                placeholder="/path/to/issue.md"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 font-mono"
              />
            </div>
          </div>
        )}

        {sourceKind === "find" && (
          <div className="mb-8">
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFind()}
                placeholder="GitHub repo URL, topic, or search prompt"
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              />
              <button
                onClick={handleFind}
                disabled={findLoading || !findQuery.trim()}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {findLoading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Search size={14} />
                )}
                Find
              </button>
            </div>

            <div className="flex gap-3 mb-4">
              <div className="flex-1">
                <select
                  value={findLanguage}
                  onChange={(e) => setFindLanguage(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-400 focus:outline-none focus:border-amber-500/50"
                >
                  <option value="">Any language</option>
                  {[
                    "TypeScript",
                    "JavaScript",
                    "Python",
                    "Go",
                    "Rust",
                    "Ruby",
                    "Java",
                    "C#",
                    "C++",
                  ].map((l) => (
                    <option key={l} value={l.toLowerCase()}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                {(["bug", "good first issue", "help wanted"] as const).map((lbl) => (
                  <button
                    key={lbl}
                    onClick={() =>
                      setFindLabel((prev) =>
                        prev.includes(lbl) ? prev.filter((x) => x !== lbl) : [...prev, lbl],
                      )
                    }
                    className={`px-2 py-1 rounded text-xs transition-colors ${
                      findLabel.includes(lbl)
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                        : "border border-zinc-800 text-zinc-500 hover:border-zinc-700"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {findError && <p className="text-xs text-red-400 mb-3">{findError}</p>}

            {findResults && (
              <div className="flex flex-col gap-2">
                {findResults.length === 0 ? (
                  <p className="text-sm text-zinc-500 py-4 text-center">
                    No issues found. Try a different query.
                  </p>
                ) : (
                  findResults.map((c) => (
                    <div
                      key={c.url}
                      className={`p-3 rounded border cursor-pointer transition-colors ${
                        selectedIssue?.url === c.url
                          ? "border-amber-500/50 bg-amber-500/5"
                          : "border-zinc-800 hover:border-zinc-700"
                      }`}
                      onClick={() => setSelectedIssue(c)}
                    >
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <p className="text-sm text-zinc-200 leading-snug">{c.title}</p>
                        <span className="text-xs font-mono text-amber-400 font-medium shrink-0">
                          {c.score}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 font-mono mb-1.5 truncate">{c.url}</p>
                      <p className="text-xs text-zinc-400">{c.reasons.slice(0, 2).join(" · ")}</p>
                      {c.claim.warnings.length > 0 && (
                        <p className="text-xs text-amber-500/70 mt-1">⚠ {c.claim.warnings[0]}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Run config — only shown after issue is confirmed */}
        {issueConfirmed && (
          <>
            <div className="border-t border-zinc-800 pt-6 mb-6">
              <div className="mb-4">
                <label className="text-xs font-medium text-zinc-400 mb-1.5 block">Model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                >
                  {Object.entries(providerGroups).map(([provider, ms]) => (
                    <optgroup key={provider} label={provider}>
                      {ms.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id.split(":")[1] ?? m.id} — ${m.inputPrice.toFixed(2)}/M in
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div className="mb-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={usePlan}
                    onChange={(e) => setUsePlan(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className="text-sm text-zinc-300">Planning phase</span>
                </label>
                <p className="text-xs text-zinc-500 mt-1 ml-5">
                  Agent plans the fix before writing code
                </p>
              </div>

              <button
                onClick={() => setShowBudget(!showBudget)}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showBudget ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                Budget limits
              </button>

              {showBudget && (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  {(
                    [
                      {
                        label: "Steps",
                        value: maxSteps,
                        min: 1,
                        max: 200,
                        step: 1,
                        onChange: setMaxSteps,
                      },
                      {
                        label: "Cost ($)",
                        value: maxCost,
                        min: 0.1,
                        max: 50,
                        step: 0.1,
                        onChange: setMaxCost,
                      },
                      {
                        label: "Time (min)",
                        value: maxTime,
                        min: 1,
                        max: 120,
                        step: 1,
                        onChange: setMaxTime,
                      },
                    ] as const
                  ).map(({ label, value, min, max, step, onChange }) => (
                    <div key={label}>
                      <label className="text-xs text-zinc-500 mb-1 block">{label}</label>
                      <input
                        type="number"
                        value={value}
                        min={min}
                        max={max}
                        step={step}
                        onChange={(e) => (onChange as (v: number) => void)(Number(e.target.value))}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50 font-mono"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {startError && <p className="text-sm text-red-400 mb-4">{startError}</p>}

            <button
              onClick={handleStartRun}
              disabled={starting || !model}
              className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {starting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Starting run…
                </>
              ) : (
                "Start run"
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function groupByProvider(models: ModelEntry[]): Record<string, ModelEntry[]> {
  const groups: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    const provider = m.provider;
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(m);
  }
  return groups;
}

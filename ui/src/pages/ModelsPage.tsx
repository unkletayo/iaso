import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModelEntry } from "../types";

export function ModelsPage() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.models
      .list()
      .then((ms) => {
        setModels(ms);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  const groups = groupByProvider(models);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-lg font-semibold text-zinc-100 mb-1">Models</h1>
        <p className="text-sm text-zinc-500 mb-8">Available models from the iaso catalogue</p>

        {loading ? (
          <p className="text-sm text-zinc-500 font-mono">Loading…</p>
        ) : models.length === 0 ? (
          <p className="text-sm text-zinc-500 font-mono">No models found</p>
        ) : (
          <div className="flex flex-col gap-6">
            {Object.entries(groups).map(([provider, ms]) => (
              <div key={provider}>
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">
                  {provider}
                </p>
                <div className="border border-zinc-800 rounded divide-y divide-zinc-800">
                  {ms.map((m) => (
                    <div key={m.id} className="flex items-center gap-4 px-4 py-2.5">
                      <span className="flex-1 text-sm font-mono text-zinc-200 truncate">
                        {m.id.split(":")[1] ?? m.id}
                      </span>
                      <div className="flex items-center gap-4 text-xs font-mono text-zinc-500 shrink-0">
                        <span title="Input price per 1M tokens">
                          ${m.inputPrice.toFixed(2)}/M in
                        </span>
                        <span title="Output price per 1M tokens">
                          ${m.outputPrice.toFixed(2)}/M out
                        </span>
                        <span title="Context window">
                          {m.contextWindow >= 1_000_000
                            ? `${(m.contextWindow / 1_000_000).toFixed(1)}M ctx`
                            : `${String(Math.round(m.contextWindow / 1_000))}k ctx`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function groupByProvider(models: ModelEntry[]): Record<string, ModelEntry[]> {
  const groups: Partial<Record<string, ModelEntry[]>> = {};
  for (const m of models) {
    const existing = groups[m.provider];
    if (existing) {
      existing.push(m);
    } else {
      groups[m.provider] = [m];
    }
  }
  return groups as Record<string, ModelEntry[]>;
}

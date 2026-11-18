import type {
  RunSummary,
  RunDetail,
  ModelEntry,
  FindCandidate,
  StartRunRequest,
  StartRunResponse,
} from "./types";

const BASE = "/api";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${String(res.status)}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  runs: {
    list: () => json<RunSummary[]>(`${BASE}/runs`),
    get: (id: string) => json<RunDetail>(`${BASE}/runs/${id}`),
    start: (body: StartRunRequest) =>
      json<StartRunResponse>(`${BASE}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  },
  models: {
    list: () => json<ModelEntry[]>(`${BASE}/models`),
  },
  find: {
    search: (params: {
      query: string;
      language?: string;
      label?: string[];
      bugsOnly?: boolean;
    }) => {
      const qs = new URLSearchParams();
      qs.set("q", params.query);
      if (params.language) qs.set("language", params.language);
      if (params.label) for (const l of params.label) qs.append("label", l);
      if (params.bugsOnly) qs.set("bugs_only", "1");
      return json<{ candidates: FindCandidate[]; repos: number; issues: number }>(
        `${BASE}/find?${qs}`,
      );
    },
  },
};

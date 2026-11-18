import { useState, useMemo } from "react";

const CONTEXT_LINES_COLLAPSED = 3;

interface DiffFile {
  header: string;
  hunks: DiffHunk[];
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

type DiffLine =
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "ctx"; text: string }
  | { kind: "hunk"; text: string };

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("diff --git ")) {
        if (currentFile) files.push(currentFile);
        currentFile = { header: line.slice("diff --git ".length), hunks: [] };
        currentHunk = null;
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      currentHunk = { header: line, lines: [{ kind: "hunk", text: line }] };
      currentFile?.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+")) {
      currentHunk.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ kind: "del", text: line.slice(1) });
    } else {
      currentHunk.lines.push({ kind: "ctx", text: line.slice(1) });
    }
  }
  if (currentFile) files.push(currentFile);
  return files;
}

interface DiffViewProps {
  diff: string;
}

export function DiffView({ diff }: DiffViewProps) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!diff.trim()) {
    return <p className="text-sm text-zinc-500 py-6 text-center font-mono">(no changes)</p>;
  }

  function toggleFile(header: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(header)) next.delete(header);
      else next.add(header);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Jump-to-file index for large diffs */}
      {files.length > CONTEXT_LINES_COLLAPSED && (
        <div className="text-xs font-mono text-zinc-500 flex flex-wrap gap-x-4 gap-y-1 pb-2 border-b border-zinc-800">
          {files.map((f) => (
            <a
              key={f.header}
              href={`#file-${encodeURIComponent(f.header)}`}
              className="hover:text-amber-400 truncate max-w-xs"
            >
              {f.header}
            </a>
          ))}
        </div>
      )}

      {files.map((file) => {
        const isCollapsed = collapsed.has(file.header);
        const addCount = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").length;
        const delCount = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "del").length;

        return (
          <div
            key={file.header}
            id={`file-${encodeURIComponent(file.header)}`}
            className="border border-zinc-800 rounded overflow-hidden"
          >
            {/* File header — sticky */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
              <button
                onClick={() => toggleFile(file.header)}
                className="text-xs text-zinc-300 font-mono flex-1 text-left truncate hover:text-zinc-100"
              >
                {file.header}
              </button>
              <span className="text-xs font-mono text-green-500">+{addCount}</span>
              <span className="text-xs font-mono text-red-500">-{delCount}</span>
            </div>

            {!isCollapsed &&
              file.hunks.map((hunk, hi) => (
                <div key={hi} className="font-mono text-xs">
                  {hunk.lines.map((line, li) => (
                    <DiffLineRow key={li} line={line} />
                  ))}
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.kind === "hunk") {
    return <div className="diff-line-hunk px-3 py-0.5 select-none">{line.text}</div>;
  }
  if (line.kind === "add") {
    return (
      <div className="diff-line-add flex">
        <span className="line-num w-6 shrink-0 text-right pr-2 select-none">+</span>
        <span className="whitespace-pre-wrap break-all">{line.text}</span>
      </div>
    );
  }
  if (line.kind === "del") {
    return (
      <div className="diff-line-del flex">
        <span className="line-num w-6 shrink-0 text-right pr-2 select-none">-</span>
        <span className="whitespace-pre-wrap break-all">{line.text}</span>
      </div>
    );
  }
  return (
    <div className="flex px-0 text-zinc-600">
      <span className="w-6 shrink-0 text-right pr-2 select-none"> </span>
      <span className="whitespace-pre-wrap break-all">{line.text}</span>
    </div>
  );
}

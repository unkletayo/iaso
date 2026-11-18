import { useMemo } from "react";
import { marked } from "marked";

interface ReportViewProps {
  report: string;
}

export function ReportView({ report }: ReportViewProps) {
  const html = useMemo(() => {
    if (!report) return "";
    return marked.parse(report) as string;
  }, [report]);

  if (!report) {
    return (
      <p className="text-sm text-zinc-500 py-6 text-center font-mono">
        No report available
      </p>
    );
  }

  return (
    <div
      className="prose prose-invert prose-sm max-w-none
        prose-headings:text-zinc-100 prose-headings:font-semibold
        prose-p:text-zinc-300 prose-p:leading-relaxed
        prose-code:text-amber-300 prose-code:font-mono prose-code:text-xs
        prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800
        prose-pre:text-zinc-300 prose-pre:font-mono prose-pre:text-xs
        prose-li:text-zinc-300
        prose-a:text-amber-400 hover:prose-a:text-amber-300
        prose-strong:text-zinc-200
        prose-hr:border-zinc-800"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export interface TruncateOptions {
  /** Output at or under this many characters is returned unchanged. */
  maxChars: number;
  headChars: number;
  tailChars: number;
}

/** Spec §5: truncate output over 10,000 characters, keeping the first 4,000 and the last 4,000. */
export const DEFAULT_TRUNCATE: TruncateOptions = {
  maxChars: 10_000,
  headChars: 4_000,
  tailChars: 4_000,
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Keep the start and end of long output, and say how much was cut from the middle. */
export function truncateOutput(text: string, opts: TruncateOptions = DEFAULT_TRUNCATE): string {
  if (text.length <= opts.maxChars) return text;

  let headEnd = opts.headChars;
  let tailStart = text.length - opts.tailChars;
  // Do not split a surrogate pair (emoji and other astral characters).
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;

  const cut = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n[... ${String(cut)} characters cut ...]\n${text.slice(tailStart)}`;
}

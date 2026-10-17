/** What a field must be, read from the tool's JSON Schema. */
export type FieldKind = "string" | "array" | "object" | "other";

export type FieldKinds = Record<string, FieldKind>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

/** A string field keeps its text; an array or object field needs the JSON inside it. */
function coerce(kind: FieldKind, text: string): unknown {
  if (kind === "string") return text.trim();
  const parsed = parseJson(text.trim());
  return parsed.ok ? parsed.value : text;
}

/**
 * Small models sometimes write several tool parameters as XML-style tags inside the first
 * array-valued one, so the call arrives as `{ filesToChange: '[...]</filesToChange>\n<testPlan>...' }`
 * with every other field missing. Split such a string back into its fields. A field that is already
 * set is never replaced.
 */
function splitEmbedded(key: string, text: string, kinds: FieldKinds): Record<string, unknown> {
  const close = text.indexOf(`</${key}>`);
  if (close === -1) return {};
  const found: Record<string, unknown> = {
    [key]: coerce(kinds[key] ?? "other", text.slice(0, close)),
  };
  const rest = text.slice(close + key.length + 3);
  for (const name of Object.keys(kinds)) {
    if (name === key) continue;
    const match = new RegExp(`<${name}>([\\s\\S]*?)(?:</${name}>|$)`).exec(rest);
    if (match?.[1] !== undefined) found[name] = coerce(kinds[name] ?? "other", match[1]);
  }
  return found;
}

/**
 * Best-effort repair of tool arguments that failed validation: JSON written as a string where an
 * array or object belongs, and parameters pasted into one another. Returns a new object, or the
 * input unchanged when it is not an object. The caller must validate the result again.
 */
export function repairInput(raw: unknown, kinds: FieldKinds): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(raw)) {
    const kind = kinds[key];
    if (typeof value !== "string" || kind === undefined || kind === "string") continue;
    const embedded = splitEmbedded(key, value, kinds);
    if (Object.keys(embedded).length > 0) {
      for (const [name, fixed] of Object.entries(embedded)) {
        if (name === key || !(name in raw)) out[name] = fixed;
      }
    } else {
      out[key] = coerce(kind, value);
    }
  }
  return out;
}

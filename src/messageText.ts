/**
 * LLM output sometimes includes literal `\` + `n` instead of newline characters.
 */
export function normalizeMessageNewlines(text: string): string {
  if (!text) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** Strip a single outer `**...**` wrapper (model sometimes bolds the whole reply). */
export function demoteAccidentalFullBold(text: string): string {
  const t = text.trim();
  if (t.length < 4 || !t.startsWith("**") || !t.endsWith("**")) return text;
  return t.slice(2, -2).trim();
}

/**
 * Insert breaks before Day N when glued to the previous word/sentence
 * ("planDay 1", "...nightlife.Day 2", etc.).
 */
export function formatAssistantItineraryText(raw: string): string {
  let s = normalizeMessageNewlines(raw).trim();
  if (!s) return s;

  s = s.replace(
    /\b(your\s+trip\s+plan)(?:\*\*|\s)*(day\s*\d+\s*:)/gi,
    "$1\n\n$2"
  );
  s = s.replace(
    /\b(updated\s+itinerary)(?:\*\*|\s)*(day\s*\d+\s*:)/gi,
    "$1\n\n$2"
  );
  s = s.replace(/\*{1,2}\s*(?=\bDay\s*\d+\s*:)/gi, "\n\n");
  s = s.replace(/([.!?])\s*(?=\bDay\s*\d+\s*:)/gi, "$1\n\n");
  s = s.replace(/([a-z0-9)])(?=\bDay\s*\d+\s*:)/gi, "$1\n\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const TITLE_LINE_RE =
  /^(?:#{1,6}\s*)?\*{0,2}(Your\s+trip\s+plan|Updated\s+itinerary)\*{0,2}\s*:?\s*$/i;

function prettifyTitleLabel(raw: string): string {
  const inner = raw
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*{1,2}/g, "")
    .replace(/:\s*$/, "")
    .trim();
  if (/^updated\s+itinerary$/i.test(inner)) return "Updated itinerary";
  if (/^your\s+trip\s+plan$/i.test(inner)) return "Your trip plan";
  return inner;
}

export function splitAssistantTitleBody(text: string): {
  title: string | null;
  body: string;
} {
  const lines = text.split("\n");
  if (lines.length === 0) return { title: null, body: text };
  const first = lines[0].trim();
  if (TITLE_LINE_RE.test(first)) {
    const title = prettifyTitleLabel(first);
    let body = lines.slice(1).join("\n").trim();
    body = demoteAccidentalFullBold(body);
    if (!body) {
      return { title: null, body: demoteAccidentalFullBold(text) };
    }
    return { title, body };
  }
  const whole = demoteAccidentalFullBold(text);
  return { title: null, body: whole };
}

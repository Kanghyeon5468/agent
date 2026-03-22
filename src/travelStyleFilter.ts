const JUNK_EXACT = new Set([
  "not specified",
  "unspecified",
  "no style",
  "nostyle",
  "none",
  "n/a",
  "na",
  "unknown",
  "undefined",
  "null",
  "any",
  "other",
  "nope",
  "tbd",
  "todo",
  "pending",
  "same",
  "-",
  "--",
  "—",
  "?"
]);

const BUDGET_TIER_LABELS = new Set(["budget", "moderate", "luxury"]);

const JUNK_SUBSTRINGS = [
  "please provide",
  "provide the",
  "specify your",
  "specify the",
  "what style",
  "user should",
  "should provide",
  "not sure",
  "don't know",
  "do not know",
  "as above",
  "see above",
  "no style"
];

function normalizeForCheck(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function isValidTravelStyleValue(raw: string): boolean {
  const s = normalizeForCheck(raw);
  if (s.length < 2 || s.length > 48) return false;
  const lower = s.toLowerCase();
  if (JUNK_EXACT.has(lower)) return false;
  if (BUDGET_TIER_LABELS.has(lower)) return false;
  for (const sub of JUNK_SUBSTRINGS) {
    if (lower.includes(sub)) return false;
  }
  if (s.includes("?")) return false;
  const words = s.split(/\s+/);
  if (words.length > 5) return false;
  return true;
}

export function sanitizeTravelStyle(raw: string): string | null {
  const s = normalizeForCheck(raw);
  if (!isValidTravelStyleValue(s)) return null;
  return s;
}

export function filterTravelStyleList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const s = sanitizeTravelStyle(raw);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

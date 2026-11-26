export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 30;

// One tag: lowercase, no leading #, letters/numbers/spaces/hyphens only, single spaces, max 30 chars.
export function normalizeTag(raw: string): string {
  return raw
    .normalize("NFKC").toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

// Accepts "a, b, c" (or newlines) or an array. De-duplicates and keeps at most MAX_TAGS.
export function normalizeTags(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(/[,\n]/);
  const out: string[] = [];
  for (const p of parts) {
    const t = normalizeTag(p);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export const tagHref = (tag: string) => `/discover?tag=${encodeURIComponent(tag)}`;

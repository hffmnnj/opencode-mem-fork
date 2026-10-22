export function vectorToJson(vector: Float32Array): string {
  return JSON.stringify(Array.from(vector));
}

export function blobToFloat32Array(value: unknown): Float32Array | null {
  if (value == null) return null;

  try {
    if (value instanceof Float32Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      if (value.byteLength === 0 || value.byteLength % 4 !== 0) {
        return null;
      }
      return new Float32Array(value);
    }

    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      const byteLength = view.byteLength;
      if (byteLength === 0 || byteLength % 4 !== 0) {
        return null;
      }
      return new Float32Array(
        view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
      );
    }

    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as number[];
        return new Float32Array(parsed);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/** Parse libSQL `vector_extract()` JSON output (preferred over raw F32_BLOB bytes). */
export function parseExtractedVector(value: unknown): Float32Array | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as number[];
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return new Float32Array(parsed);
    } catch {
      return null;
    }
  }
  return blobToFloat32Array(value);
}

export function distanceToSimilarity(distance: number): number {
  const similarity = 1 - Number(distance);
  if (!Number.isFinite(similarity)) return 0;
  // Clamp float artifacts (docs: cos-distance can be slightly negative near exact matches).
  return Math.max(0, Math.min(1, similarity));
}

/** Canonical text used for tag-vector embeddings (must stay consistent across write paths). */
export function formatTagsForEmbedding(tags: string[]): string {
  return `Topics: ${tags.join(", ")}`;
}

/** Maximum bounded query terms kept for lexical retrieval. */
export const MAX_QUERY_TERMS = 16;

/** Canonicalize lexical text: NFC normalization then lowercase (shared query/haystack/needle). */
function canonicalizeLexicalText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * True for Unicode word characters (letters, marks, numbers).
 * Separators such as `_ - . /`, whitespace, punctuation, and emoji are boundaries.
 */
function isLexicalWordChar(char: string): boolean {
  if (!char) return false;
  return /[\p{L}\p{M}\p{N}]/u.test(char);
}

/**
 * Split an original-case identifier segment on camelCase/acronym boundaries.
 * `getHTTPResponse` -> `["get", "HTTP", "Response"]`,
 * `XMLHttpRequest` -> `["XML", "Http", "Request"]`.
 * Letter/digit transitions alone never split (so `word0` stays intact).
 */
function splitCamelComponents(segment: string): string[] {
  const normalized = segment.normalize("NFC");
  const chars = Array.from(normalized);
  if (chars.length <= 1) return chars.length === 0 ? [] : [normalized];
  const isLower = (ch: string): boolean => /\p{Ll}/u.test(ch);
  const isUpper = (ch: string): boolean => /\p{Lu}/u.test(ch) || /\p{Lt}/u.test(ch);
  const isDigit = (ch: string): boolean => /\p{N}/u.test(ch);
  const isLowerLike = (ch: string): boolean => /\p{Ll}/u.test(ch) || /\p{Lt}/u.test(ch);
  const parts: string[] = [];
  let current = chars[0] ?? "";
  for (let i = 1; i < chars.length; i++) {
    const prev = chars[i - 1] ?? "";
    const curr = chars[i] ?? "";
    const next = i + 1 < chars.length ? (chars[i + 1] ?? "") : "";
    const lowerToUpper = (isLower(prev) || isDigit(prev)) && isUpper(curr);
    const acronymBoundary = isUpper(prev) && isUpper(curr) && isLowerLike(next);
    if (lowerToUpper || acronymBoundary) {
      parts.push(current);
      current = curr;
    } else {
      current += curr;
    }
  }
  parts.push(current);
  return parts;
}

/** Split free text into lowercase tokens for keyword / hybrid search. */
export function tokenizeQueryText(text: string | undefined | null): string[] {
  if (!text) return [];
  const normalized = text.normalize("NFC");
  // Split chunks on whitespace and punctuation, but keep `. _ / -` inside a
  // chunk so full code identifiers/paths survive (e.g. `vector-search.ts`).
  // `%` and `\` are treated as delimiters so LIKE wildcards never become tokens.
  // Unicode-aware: anything that is not a letter/mark/number or `. _ / -`
  // delimits (so emoji and non-ASCII punctuation are boundaries too).
  const chunks = normalized
    .split(/[^\p{L}\p{M}\p{N}._/-]+/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (token: string): void => {
    const cleaned = token.replace(/^[._/-]+|[._/-]+$/g, "");
    if (cleaned.length <= 1) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  for (const chunk of chunks) {
    if (out.length >= MAX_QUERY_TERMS) break;
    const cleanedChunk = chunk.replace(/^[._/-]+|[._/-]+$/g, "");
    if (!cleanedChunk) continue;
    // Preserve the full identifier/path first (canonical NFC+lowercase), then
    // its split components. Camel splitting runs on original case so `HTTP`
    // and `Http` distinctions survive before lowercasing.
    const fullLower = canonicalizeLexicalText(cleanedChunk).replace(/^[._/-]+|[._/-]+$/g, "");
    if (fullLower.length <= 1) continue;
    push(fullLower);
    if (out.length >= MAX_QUERY_TERMS) break;
    const parts = cleanedChunk.split(/[._/-]+/);
    for (const part of parts) {
      if (out.length >= MAX_QUERY_TERMS) break;
      if (!part) continue;
      for (const camelPart of splitCamelComponents(part)) {
        if (out.length >= MAX_QUERY_TERMS) break;
        if (!camelPart) continue;
        push(canonicalizeLexicalText(camelPart));
      }
    }
  }
  return out.slice(0, MAX_QUERY_TERMS);
}

/**
 * Boundary-aware substring match: `in` must not match `index`, but `vector`
 * matches `vector-search.ts` because `-`, `.`, `/`, whitespace, punctuation,
 * emoji, and string boundaries count as token boundaries (only Unicode
 * letters/marks/numbers continue a token). Component queries also match
 * camelCase/acronym symbols (`http` matches `getHTTPResponse`) via exact
 * component equality, never arbitrary substring. Pure and case-insensitive
 * with NFC normalization; `%`/`_`/`\` are matched literally.
 */
export function hasTokenBoundaryMatch(haystack: string, needle: string): boolean {
  const token = canonicalizeLexicalText(needle ?? "");
  if (!token) return false;
  const hayOriginal = (haystack ?? "").normalize("NFC");
  if (!hayOriginal) return false;
  const hay = hayOriginal.toLowerCase();
  let index = hay.indexOf(token);
  while (index !== -1) {
    const afterIndex = index + token.length;
    // indexOf offsets are UTF-16 units; inspect complete adjacent code points
    // so supplementary-plane letters do not masquerade as punctuation.
    const before = Array.from(hay.slice(Math.max(0, index - 2), index)).at(-1) ?? "";
    const after = Array.from(hay.slice(afterIndex, afterIndex + 2))[0] ?? "";
    const beforeOk = before === "" || !isLexicalWordChar(before);
    const afterOk = after === "" || !isLexicalWordChar(after);
    if (beforeOk && afterOk) return true;
    index = hay.indexOf(token, index + 1);
  }
  // Full identifiers/paths and anything with punctuation already attempted
  // directly above; camel-component matching is only for single-word tokens.
  if (/[^\p{L}\p{M}\p{N}]/u.test(token)) return false;
  const chunks = hayOriginal.split(/[^\p{L}\p{M}\p{N}._/-]+/u);
  for (const chunk of chunks) {
    if (!chunk) continue;
    const trimmed = chunk.replace(/^[._/-]+|[._/-]+$/g, "");
    if (!trimmed) continue;
    for (const segment of trimmed.split(/[._/-]+/)) {
      if (!segment) continue;
      for (const component of splitCamelComponents(segment)) {
        if (!component) continue;
        if (canonicalizeLexicalText(component) === token) return true;
      }
    }
  }
  return false;
}

/**
 * Pure lexical coverage: fraction of bounded query tokens found in
 * content and/or tags with token-boundary matching. Returns 0..1
 * (0 when there are no query tokens). Used for both keyword recall and
 * hydration scoring so every candidate is scored from the same hydrated text.
 */
export function computeLexicalCoverage(
  content: string | null | undefined,
  tags: string | null | undefined,
  tokens: string[]
): number {
  if (!tokens || tokens.length === 0) return 0;
  const body = content ?? "";
  const tagText = tags ?? "";
  let matched = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (hasTokenBoundaryMatch(body, token) || hasTokenBoundaryMatch(tagText, token)) {
      matched += 1;
    }
  }
  return matched / Math.max(tokens.length, 1);
}

/**
 * Boundary-aware tag boost: fraction of query tokens found in tags only.
 * Requires normalized token/tag boundaries, never arbitrary substring.
 */
export function computeTagBoost(tags: string | null | undefined, tokens: string[]): number {
  if (!tokens || tokens.length === 0) return 0;
  if (!tags) return 0;
  return computeLexicalCoverage("", tags, tokens);
}

/**
 * Escape LIKE wildcards so user tokens are matched literally.
 * Pair with `ESCAPE '\\'` in SQL.
 */
export function escapeLikePattern(token: string): string {
  return token.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function parseSessionIdFromMetadata(metadata: string | undefined | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed.sessionID === "string" && parsed.sessionID.length > 0
      ? parsed.sessionID
      : null;
  } catch {
    return null;
  }
}

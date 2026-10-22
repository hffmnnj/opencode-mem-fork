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

/** Split free text into lowercase tokens for keyword / hybrid search. */
export function tokenizeQueryText(text: string | undefined | null): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Split chunks on whitespace and punctuation, but keep `. _ / -` inside a
  // chunk so full code identifiers/paths survive (e.g. `vector-search.ts`).
  // `%` and `\` are treated as delimiters so LIKE wildcards never become tokens.
  const chunks = lower
    .split(/[\s,;:"'()[\]{}!?*+=|&<>@#$%^`~\\]+/)
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
    if (cleanedChunk.length <= 1) continue;
    // Preserve the full identifier/path first, then its split components.
    push(cleanedChunk);
    if (out.length >= MAX_QUERY_TERMS) break;
    const parts = cleanedChunk.split(/[._/-]+/);
    for (const part of parts) {
      if (out.length >= MAX_QUERY_TERMS) break;
      push(part);
    }
  }
  return out.slice(0, MAX_QUERY_TERMS);
}

/**
 * Boundary-aware substring match: `in` must not match `index`, but `vector`
 * matches `vector-search.ts` because `-`, `.`, `/`, whitespace, and string
 * boundaries count as token boundaries (only `[a-z0-9]` continues a token).
 * Pure and case-insensitive; `%`/`_`/`\` are matched literally.
 */
export function hasTokenBoundaryMatch(haystack: string, needle: string): boolean {
  const hay = (haystack ?? "").toLowerCase();
  const token = (needle ?? "").toLowerCase();
  if (!token) return false;
  let index = hay.indexOf(token);
  while (index !== -1) {
    const before = index === 0 ? "" : (hay[index - 1] ?? "");
    const afterIndex = index + token.length;
    const after = afterIndex >= hay.length ? "" : (hay[afterIndex] ?? "");
    const beforeOk = before === "" || !/[a-z0-9]/.test(before);
    const afterOk = after === "" || !/[a-z0-9]/.test(after);
    if (beforeOk && afterOk) return true;
    index = hay.indexOf(token, index + 1);
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

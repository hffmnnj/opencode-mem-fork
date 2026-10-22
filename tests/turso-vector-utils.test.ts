import { describe, expect, it } from "bun:test";
import {
  computeLexicalCoverage,
  computeTagBoost,
  distanceToSimilarity,
  escapeLikePattern,
  formatTagsForEmbedding,
  hasTokenBoundaryMatch,
  parseSessionIdFromMetadata,
  tokenizeQueryText,
} from "../src/services/turso/vector-utils.js";

describe("turso vector utils", () => {
  it("clamps cosine distance float artifacts into [0, 1] similarity", () => {
    expect(distanceToSimilarity(0)).toBe(1);
    expect(distanceToSimilarity(1)).toBe(0);
    expect(distanceToSimilarity(-1e-14)).toBe(1);
    expect(distanceToSimilarity(2)).toBe(0);
    expect(distanceToSimilarity(Number.NaN)).toBe(0);
  });

  it("formats tag embedding text consistently", () => {
    expect(formatTagsForEmbedding(["auth", "jwt"])).toBe("Topics: auth, jwt");
  });

  it("tokenizes query text and escapes LIKE wildcards", () => {
    expect(tokenizeQueryText("Hello, world_test")).toEqual([
      "hello",
      "world_test",
      "world",
      "test",
    ]);
    expect(escapeLikePattern("100%_done")).toBe("100\\%\\_done");
    expect(parseSessionIdFromMetadata(JSON.stringify({ sessionID: "s1" }))).toBe("s1");
    expect(parseSessionIdFromMetadata("{bad")).toBeNull();
  });

  it("tokenizeQueryText_dedupesDuplicateWords", () => {
    expect(tokenizeQueryText("alpha alpha ALPHA")).toEqual(["alpha"]);
  });

  it("tokenizeQueryText_preservesCodeIdentifiersAndPaths", () => {
    const tokens = tokenizeQueryText("src/services/turso/vector-search.ts");
    expect(tokens).toContain("src/services/turso/vector-search.ts");
    expect(tokens).toContain("vector");
    expect(tokens).toContain("search");
    expect(tokens).toContain("ts");
    expect(tokens.length).toBeLessThanOrEqual(16);
  });

  it("tokenizeQueryText_boundsTermsToSixteen", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    expect(tokenizeQueryText(words)).toHaveLength(16);
  });

  it("hasTokenBoundaryMatch_rejectsSubstringFalsePositives", () => {
    expect(hasTokenBoundaryMatch("index", "in")).toBe(false);
    expect(hasTokenBoundaryMatch("superuser account", "user")).toBe(false);
    expect(hasTokenBoundaryMatch("user profile settings", "user")).toBe(true);
    expect(hasTokenBoundaryMatch("see vector-search.ts here", "vector")).toBe(true);
    expect(hasTokenBoundaryMatch("100%_done", "done")).toBe(true);
  });

  it("computeLexicalCoverage_scoresFullAndPartialMatches", () => {
    expect(computeLexicalCoverage("alpha beta gamma", "", ["alpha", "beta", "gamma"])).toBe(1);
    expect(computeLexicalCoverage("alpha only", "", ["alpha", "beta", "gamma"])).toBeCloseTo(
      1 / 3,
      10
    );
    expect(computeLexicalCoverage("index", "", ["in"])).toBe(0);
    expect(computeLexicalCoverage("", "", [])).toBe(0);
  });

  it("computeTagBoost_requiresTokenBoundaries", () => {
    expect(computeTagBoost("indexing", ["in"])).toBe(0);
    expect(computeTagBoost("auth, jwt", ["jwt"])).toBe(1);
    expect(computeTagBoost("", ["jwt"])).toBe(0);
  });

  it("tokenizeQueryText_splitsCamelAndAcronymDeterministically", () => {
    expect(tokenizeQueryText("getHTTPResponse")).toEqual([
      "gethttpresponse",
      "get",
      "http",
      "response",
    ]);
    expect(tokenizeQueryText("XMLHttpRequest")).toEqual([
      "xmlhttprequest",
      "xml",
      "http",
      "request",
    ]);
    expect(tokenizeQueryText("beta alpha")).toEqual(["beta", "alpha"]);
  });

  it("tokenizeQueryText_normalizesUnicodeNFC", () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(tokenizeQueryText(decomposed)).toEqual(tokenizeQueryText(composed));
    expect(tokenizeQueryText(decomposed)).toEqual(["caf\u00e9"]);
    expect(tokenizeQueryText("\u03b1\u03b2\u03b3")).toEqual(["\u03b1\u03b2\u03b3"]);
    expect(tokenizeQueryText("\u043f\u0440\u0438\u0432\u0435\u0442")).toEqual([
      "\u043f\u0440\u0438\u0432\u0435\u0442",
    ]);
  });

  it("tokenizeQueryText_treatsEmojiAndPunctuationAsBoundaries", () => {
    expect(tokenizeQueryText("hello\ud83d\ude00world")).toEqual(["hello", "world"]);
    expect(tokenizeQueryText("hello,world;test")).toEqual(["hello", "world", "test"]);
    expect(tokenizeQueryText("100%_done")).toEqual(["100", "done"]);
  });

  it("tokenizeQueryText_keepsSingleCjkTermWithoutSegmentationClaims", () => {
    expect(tokenizeQueryText("\u65e5\u672c\u8a9e")).toEqual(["\u65e5\u672c\u8a9e"]);
    expect(tokenizeQueryText("\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8")).toEqual([
      "\u65e5\u672c\u8a9e",
      "\u30c6\u30b9\u30c8",
    ]);
  });

  it("tokenizeQueryText_handlesEmptyInputs", () => {
    expect(tokenizeQueryText("")).toEqual([]);
    expect(tokenizeQueryText(null)).toEqual([]);
    expect(tokenizeQueryText(undefined)).toEqual([]);
    expect(tokenizeQueryText("a")).toEqual([]);
  });

  it("hasTokenBoundaryMatch_rejectsAsciiOnlyFalseBoundaries", () => {
    expect(hasTokenBoundaryMatch("𐐨auth", "auth")).toBe(false);
    expect(hasTokenBoundaryMatch("auth𐐨", "auth")).toBe(false);
    expect(hasTokenBoundaryMatch("auth\u00e9", "auth")).toBe(false);
    expect(hasTokenBoundaryMatch("\u03b1\u03b2\u03b3", "\u03b2")).toBe(false);
    expect(
      hasTokenBoundaryMatch("\u043f\u0440\u0438\u0432\u0435\u0442", "\u0440\u0438\u0432")
    ).toBe(false);
    expect(hasTokenBoundaryMatch("caf\u00e9 au lait", "caf\u00e9")).toBe(true);
    expect(
      hasTokenBoundaryMatch("\u03b1\u03b2\u03b3 \u03b4\u03b5\u03b6", "\u03b1\u03b2\u03b3")
    ).toBe(true);
    expect(
      hasTokenBoundaryMatch(
        "\u043f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440",
        "\u043f\u0440\u0438\u0432\u0435\u0442"
      )
    ).toBe(true);
  });

  it("hasTokenBoundaryMatch_matchesComposedAndDecomposedNFC", () => {
    expect(hasTokenBoundaryMatch("cafe\u0301 au lait", "caf\u00e9")).toBe(true);
    expect(hasTokenBoundaryMatch("caf\u00e9 au lait", "cafe\u0301")).toBe(true);
  });

  it("hasTokenBoundaryMatch_matchesCamelComponentsWithoutSubstringLeaks", () => {
    expect(hasTokenBoundaryMatch("getHTTPResponse", "http")).toBe(true);
    expect(hasTokenBoundaryMatch("getHTTPResponse", "response")).toBe(true);
    expect(hasTokenBoundaryMatch("getHTTPResponse", "get")).toBe(true);
    expect(hasTokenBoundaryMatch("getHTTPResponse", "gethttpresponse")).toBe(true);
    expect(hasTokenBoundaryMatch("XMLHttpRequest", "xml")).toBe(true);
    expect(hasTokenBoundaryMatch("XMLHttpRequest", "http")).toBe(true);
    expect(hasTokenBoundaryMatch("XMLHttpRequest", "request")).toBe(true);
    expect(hasTokenBoundaryMatch("uses vectorSearch_helper here", "search")).toBe(true);
    expect(hasTokenBoundaryMatch("index", "in")).toBe(false);
  });

  it("hasTokenBoundaryMatch_treatsEmojiAndPunctuationAsBoundaries", () => {
    expect(hasTokenBoundaryMatch("hello\ud83d\ude00world", "world")).toBe(true);
    expect(hasTokenBoundaryMatch("hello\ud83d\ude00world", "hello")).toBe(true);
    expect(hasTokenBoundaryMatch("hello,world", "world")).toBe(true);
    expect(hasTokenBoundaryMatch("", "a")).toBe(false);
    expect(hasTokenBoundaryMatch("a", "")).toBe(false);
    expect(hasTokenBoundaryMatch("", "")).toBe(false);
  });

  it("hasTokenBoundaryMatch_matchesCjkWhenDelimited", () => {
    expect(
      hasTokenBoundaryMatch("\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8", "\u65e5\u672c\u8a9e")
    ).toBe(true);
    expect(
      hasTokenBoundaryMatch("\u65e5\u672c\u8a9e \u30c6\u30b9\u30c8", "\u30c6\u30b9\u30c8")
    ).toBe(true);
  });

  it("computeLexicalCoverage_matchesCamelComponents", () => {
    expect(computeLexicalCoverage("uses getHTTPResponse here", "", ["http"])).toBe(1);
    expect(computeLexicalCoverage("uses getHTTPResponse here", "", ["http", "response"])).toBe(1);
    expect(computeLexicalCoverage("index", "", ["in"])).toBe(0);
    expect(computeLexicalCoverage("auth\u00e9", "", ["auth"])).toBe(0);
  });
});

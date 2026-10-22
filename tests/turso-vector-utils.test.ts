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
});

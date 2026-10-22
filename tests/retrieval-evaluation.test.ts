import { describe, expect, it } from "bun:test";
import {
  cosineSimilarity,
  hybridScoreForDoc,
  mrrAtK,
  ndcgAtK,
  percentileP,
  rankByScore,
  recallAtK,
  runEvaluation,
  type EmbedFn,
  type EvalDoc,
  type EvalQuery,
} from "../scripts/evaluate-retrieval.js";

// Pure-helper and runner checks only: every vector here is hand-built, so no
// embedding service, database, or network is involved.
describe("retrieval evaluation helpers", () => {
  it("cosineSimilarity_identicalVectors_returnsOne", () => {
    const vec = new Float32Array([0.2, 0.5, 0.7]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 10);
  });

  it("cosineSimilarity_orthogonalVectors_returnsZero", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it("cosineSimilarity_zeroVector_returnsZero", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
  it("rejects mismatched vector dimensions instead of silently truncating", () => {
    expect(() => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1]))).toThrow(
      "Embedding dimensions do not match"
    );
  });

  it("hybridScoreForDoc_queryWithTerms_matchesWeightedBlend", () => {
    // Query token "zzzz" appears in neither content nor tags, so lexical
    // coverage and tag boost are 0: score must equal 0.5*content + 0.3*tags.
    const { score, components } = hybridScoreForDoc(0.8, 0.4, "aaaa", "bbbb", "zzzz");
    expect(score).toBeCloseTo(0.5 * 0.8 + 0.3 * 0.4, 10);
    expect(components.keyword).toBe(0);
  });

  it("hybridScoreForDoc_emptyQuery_usesQuerylessBlend", () => {
    const { score } = hybridScoreForDoc(0.8, 0.4, "aaaa", "bbbb", "");
    expect(score).toBeCloseTo(0.6 * 0.8 + 0.4 * 0.4, 10);
  });

  it("rankByScore_ties_breakByDateThenId", () => {
    const ranked = rankByScore([
      { id: "b", score: 0.5, createdAt: 2 },
      { id: "a", score: 0.5, createdAt: 2 },
      { id: "c", score: 0.5, createdAt: 3 },
      { id: "d", score: 0.9, createdAt: 1 },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["d", "c", "a", "b"]);
  });

  it("metrics_binaryExample_matchesHandComputedValues", () => {
    // Single query, relevant doc at rank 2 of 3: recall 1, MRR 1/2,
    // NDCG = (1/log2(3)) / 1.
    const ranked = [["x", "target", "y"]];
    const relevant = [["target"]];
    expect(recallAtK(ranked, relevant, 3)).toBe(1);
    expect(mrrAtK(ranked, relevant, 3)).toBe(0.5);
    expect(ndcgAtK(ranked, relevant, 3)).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it("metrics_absentRelevant_scoresZero", () => {
    const ranked = [["x", "y", "z"]];
    const relevant = [["target"]];
    expect(recallAtK(ranked, relevant, 3)).toBe(0);
    expect(mrrAtK(ranked, relevant, 3)).toBe(0);
    expect(ndcgAtK(ranked, relevant, 3)).toBe(0);
  });
  it("recall counts missing relevant documents rather than just the first hit", () => {
    expect(recallAtK([["one", "unrelated"]], [["one", "two"]], 3)).toBe(0.5);
    expect(recallAtK([["one", "one"]], [["one", "two"]], 3)).toBe(0.5);
  });

  it("percentileP_nearestRank_matchesOrdering", () => {
    expect(percentileP([1, 2, 3, 4], 50)).toBe(2);
    expect(percentileP([1, 2, 3, 4], 95)).toBe(4);
    expect(percentileP([], 50)).toBe(0);
  });
});

describe("retrieval evaluation runner", () => {
  const docs: EvalDoc[] = [
    { id: "doc-a", content: "doc A content", tags: ["ta"], createdAt: 1000 },
    { id: "doc-b", content: "doc B content", tags: ["tb"], createdAt: 2000 },
  ];
  const table: Record<string, Float32Array> = {
    "doc A content": new Float32Array([1, 0]),
    "Topics: ta": new Float32Array([1, 0]),
    "doc B content": new Float32Array([0.9, 0.1]),
    "Topics: tb": new Float32Array([0.9, 0.1]),
  };
  const stubEmbed: EmbedFn = async (text) => {
    // Exact content/tag matches score 1; anything else is orthogonal.
    return table[text] ?? new Float32Array([0, 1]);
  };

  it("runEvaluation_thresholdFiltersHybridButBaselinesStayRankOnly", async () => {
    const queries: EvalQuery[] = [
      {
        id: "q-hit",
        text: "doc A content",
        relevantIds: ["doc-a"],
        answerable: true,
        kind: "test",
      },
      {
        id: "q-none",
        text: "unrelated zzz shout",
        relevantIds: [],
        answerable: false,
        kind: "no-answer",
      },
    ];
    const report = await runEvaluation(docs, queries, stubEmbed, 0.99, 3);

    const hit = report.perQuery.find((entry) => entry.id === "q-hit")!;
    expect(hit.hybridTop[0]!.id).toBe("doc-a");
    const none = report.perQuery.find((entry) => entry.id === "q-none")!;
    // Below-threshold hybrid returns nothing for the no-answer query ...
    expect(none.hybridTop).toEqual([]);
    expect(none.hybridBeforeThresholdTop).toHaveLength(2);
    expect(none.hybridBeforeThresholdTop.every((entry) => !entry.passedThreshold)).toBe(true);
    // ... while rank-only baselines still list candidates (N/A abstention).
    expect(none.vectorOnlyTop.length).toBeGreaterThan(0);
    expect(none.listTop.length).toBeGreaterThan(0);
    expect(report.metrics.vectorOnly.noAnswerFalsePositiveRate).toBeNull();
    expect(report.metrics.listRecency.noAnswerFalsePositiveRate).toBeNull();
    expect(report.metrics.hybrid.noAnswerFalsePositiveRate).toBe(0);
    expect(report.dataset.answerableCount).toBe(1);
    expect(report.dataset.noAnswerCount).toBe(1);
  });
});

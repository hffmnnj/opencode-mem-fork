/**
 * Small repeatable retrieval evaluation using the actually configured remote
 * embedding service. Honest local check, not a benchmark: a fixed synthetic
 * fixture is ranked in memory with real remote vectors plus the existing
 * lexical helpers and the unchanged hybrid score formula.
 *
 * Usage: bun scripts/evaluate-retrieval.ts > /var/tmp/opencode/opencode/mem-retrieval-evaluation.json
 *
 * Stdout is the JSON report only; human progress goes to stderr. Never prints
 * endpoint URLs, keys, headers, or config dumps.
 */
import { CONFIG } from "../src/config.js";
import { EmbeddingService, isEmbeddingMisconfigured } from "../src/services/embedding.js";
import {
  computeLexicalCoverage,
  computeTagBoost,
  formatTagsForEmbedding,
  tokenizeQueryText,
} from "../src/services/turso/vector-utils.js";

export type EvalDoc = {
  id: string;
  content: string;
  tags: string[];
  createdAt: number;
};

export type EvalQuery = {
  id: string;
  text: string;
  relevantIds: string[];
  answerable: boolean;
  kind: string;
};

export type RankedEntry = { id: string; score: number };

type DocVectors = {
  doc: EvalDoc;
  contentVec: Float32Array;
  tagsVec: Float32Array;
};

export const RETRIEVAL_EVAL_LIMIT = 3;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Cosine similarity in 0..1 (0 on zero norms), matching clamped DB semantics. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions do not match");
  const n = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/**
 * Same blend as TursoVectorSearch.searchInShard: 0.5 content + 0.3 tags +
 * 0.2 lexical coverage with query text, else 0.6 content + 0.4 tags.
 * finalTags = max(tags cosine, boundary-aware tag boost). Output clamped.
 */
export function hybridScoreForDoc(
  contentSim: number,
  tagsSim: number,
  content: string,
  tagsText: string,
  queryText: string | undefined
): { score: number; components: { content: number; tags: number; keyword: number } } {
  const tokens = tokenizeQueryText(queryText);
  const hasTokens = tokens.length > 0;
  const exactBoost = computeTagBoost(tagsText, tokens);
  const finalTagsSim = Math.max(tagsSim, exactBoost);
  const keywordSim = hasTokens ? computeLexicalCoverage(content, tagsText, tokens) : 0;
  const raw = hasTokens
    ? contentSim * 0.5 + finalTagsSim * 0.3 + keywordSim * 0.2
    : contentSim * 0.6 + finalTagsSim * 0.4;
  return {
    score: clamp01(raw),
    components: { content: contentSim, tags: finalTagsSim, keyword: keywordSim },
  };
}

function compareRanked(
  a: RankedEntry & { createdAt: number },
  b: RankedEntry & { createdAt: number }
): number {
  return b.score - a.score || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Deterministic score desc / createdAt desc / id asc ordering. */
export function rankByScore(
  entries: Array<RankedEntry & { createdAt: number }>
): Array<RankedEntry & { createdAt: number }> {
  return [...entries].sort(compareRanked);
}

/** Mean Recall@k: retrieved relevant documents / all relevant documents per query. */
export function recallAtK(rankedIds: string[][], relevant: string[][], k: number): number {
  if (rankedIds.length === 0) return 0;
  let recall = 0;
  for (let i = 0; i < rankedIds.length; i++) {
    const top = rankedIds[i]!.slice(0, k);
    const expected = new Set(relevant[i]);
    const found = new Set(top.filter((id) => expected.has(id)));
    recall += expected.size > 0 ? found.size / expected.size : 0;
  }
  return recall / rankedIds.length;
}

/**
 * MRR@k: mean of 1/rank(first relevant doc within top-k), else 0.
 * Binary labels; rank is 1-based.
 */
export function mrrAtK(rankedIds: string[][], relevant: string[][], k: number): number {
  if (rankedIds.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < rankedIds.length; i++) {
    const top = rankedIds[i]!.slice(0, k);
    const rank = top.findIndex((id) => relevant[i]!.includes(id));
    if (rank >= 0) sum += 1 / (rank + 1);
  }
  return sum / rankedIds.length;
}

/**
 * NDCG@k with binary labels: DCG@k = sum(rel_i / log2(i+1)) over top-k,
 * IDCG@k = DCG of the ideal ranking (all relevant docs first). Mean over queries.
 */
export function ndcgAtK(rankedIds: string[][], relevant: string[][], k: number): number {
  if (rankedIds.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < rankedIds.length; i++) {
    const top = rankedIds[i]!.slice(0, k);
    let dcg = 0;
    for (let j = 0; j < top.length; j++) {
      if (relevant[i]!.includes(top[j]!)) dcg += 1 / Math.log2(j + 2);
    }
    const idealHits = Math.min(k, relevant[i]!.length);
    let idcg = 0;
    for (let j = 0; j < idealHits; j++) idcg += 1 / Math.log2(j + 2);
    sum += idcg > 0 ? dcg / idcg : 0;
  }
  return sum / rankedIds.length;
}

/** Nearest-rank percentile over ascending-sorted values. */
export function percentileP(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  );
  return sortedAsc[rank]!;
}

export type EmbedFn = (text: string, task: "document" | "query") => Promise<Float32Array>;

export type SystemMetrics = {
  recallAt3: number;
  mrrAt3: number;
  ndcgAt3: number;
  /** Null when the system has no calibrated cutoff (rank-only baseline). */
  noAnswerFalsePositiveRate: number | null;
};

export type PerQueryReport = {
  id: string;
  kind: string;
  answerable: boolean;
  relevantIds: string[];
  hybridTop: Array<{ id: string; score: number; passedThreshold: boolean }>;
  hybridBeforeThresholdTop: Array<{ id: string; score: number; passedThreshold: boolean }>;
  vectorOnlyTop: Array<{ id: string; score: number }>;
  listTop: Array<{ id: string }>;
  firstRelevantRank: { hybrid: number | null; vectorOnly: number | null; list: number | null };
  embedMs: number;
  rankMs: number;
};

export type EvaluationReport = {
  dataset: {
    version: string;
    documentCount: number;
    queryCount: number;
    answerableCount: number;
    noAnswerCount: number;
  };
  metrics: {
    hybrid: SystemMetrics;
    vectorOnly: SystemMetrics;
    listRecency: SystemMetrics;
    formula: string;
  };
  thresholdTreatment: Record<string, string>;
  timingsMs: {
    documentEmbeddingTotalMs: number;
    perQueryEmbed: { p50: number; p95: number };
    perQueryRank: { p50: number; p95: number };
    perQueryTotal: { p50: number; p95: number };
    includesEmbeddingCalls: string;
  };
  perQuery: PerQueryReport[];
  limitations: string[];
};

/**
 * Injectable runner: uses the caller's embed function, ranks in memory, and
 * applies the threshold to hybrid results only. Baselines are rank-only (no calibrated
 * cutoff is manufactured for raw cosine or recency order).
 */
export async function runEvaluation(
  docs: EvalDoc[],
  queries: EvalQuery[],
  embed: EmbedFn,
  threshold: number,
  limit = RETRIEVAL_EVAL_LIMIT
): Promise<EvaluationReport> {
  const vectors: DocVectors[] = [];
  const documentStart = performance.now();
  for (const doc of docs) {
    const contentVec = await embed(doc.content, "document");
    const tagsVec = await embed(formatTagsForEmbedding(doc.tags), "document");
    vectors.push({ doc, contentVec, tagsVec });
  }
  const documentEmbeddingTotalMs = performance.now() - documentStart;

  const listOrder = [...docs]
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((d) => d.id);

  const perQuery: PerQueryReport[] = [];
  const embedTimes: number[] = [];
  const rankTimes: number[] = [];

  for (const query of queries) {
    const embedStart = performance.now();
    const queryVec = await embed(query.text, "query");
    const embedMs = performance.now() - embedStart;

    const rankStart = performance.now();
    const tagsText = (doc: EvalDoc): string => doc.tags.join(",");
    const scored = vectors.map(({ doc, contentVec, tagsVec }) => {
      const contentSim = cosineSimilarity(queryVec, contentVec);
      const tagsSim = cosineSimilarity(queryVec, tagsVec);
      const { score } = hybridScoreForDoc(
        contentSim,
        tagsSim,
        doc.content,
        tagsText(doc),
        query.text
      );
      return { id: doc.id, score, contentSim, createdAt: doc.createdAt };
    });
    const hybridRanked = rankByScore(scored);
    const hybridThresholded = hybridRanked.filter((entry) => entry.score >= threshold);
    const vectorRanked = rankByScore(
      scored.map((entry) => ({ id: entry.id, score: entry.contentSim, createdAt: entry.createdAt }))
    );
    const rankMs = performance.now() - rankStart;

    embedTimes.push(embedMs);
    rankTimes.push(rankMs);

    const rankOf = (ids: string[]): number | null => {
      const rank = ids.findIndex((id) => query.relevantIds.includes(id));
      return rank >= 0 ? rank + 1 : null;
    };
    perQuery.push({
      id: query.id,
      kind: query.kind,
      answerable: query.answerable,
      relevantIds: query.relevantIds,
      hybridTop: hybridThresholded.slice(0, limit).map((entry) => ({
        id: entry.id,
        score: entry.score,
        passedThreshold: true,
      })),
      hybridBeforeThresholdTop: hybridRanked.slice(0, limit).map((entry) => ({
        id: entry.id,
        score: entry.score,
        passedThreshold: entry.score >= threshold,
      })),
      vectorOnlyTop: vectorRanked
        .slice(0, limit)
        .map((entry) => ({ id: entry.id, score: entry.score })),
      listTop: listOrder.slice(0, limit).map((id) => ({ id })),
      firstRelevantRank: {
        hybrid: query.answerable
          ? rankOf(hybridThresholded.slice(0, limit).map((entry) => entry.id))
          : null,
        vectorOnly: query.answerable
          ? rankOf(vectorRanked.slice(0, limit).map((entry) => entry.id))
          : null,
        list: query.answerable ? rankOf(listOrder.slice(0, limit)) : null,
      },
      embedMs,
      rankMs,
    });
  }

  const answerable = perQuery.filter((entry) => entry.answerable);
  const noAnswer = perQuery.filter((entry) => !entry.answerable);
  const hybridIds = answerable.map((entry) => entry.hybridTop.map((top) => top.id));
  const vectorIds = answerable.map((entry) => entry.vectorOnlyTop.map((top) => top.id));
  const listIds = answerable.map((entry) => entry.listTop.map((top) => top.id));
  const relevant = answerable.map((entry) => entry.relevantIds);

  const noAnswerFp =
    noAnswer.length === 0
      ? 0
      : noAnswer.filter((entry) => entry.hybridTop.length > 0).length / noAnswer.length;

  const totals = perQuery.map((entry) => entry.embedMs + entry.rankMs);
  const asc = (values: number[]): number[] => [...values].sort((a, b) => a - b);

  return {
    dataset: {
      version: "",
      documentCount: docs.length,
      queryCount: queries.length,
      answerableCount: answerable.length,
      noAnswerCount: noAnswer.length,
    },
    metrics: {
      hybrid: {
        recallAt3: recallAtK(hybridIds, relevant, limit),
        mrrAt3: mrrAtK(hybridIds, relevant, limit),
        ndcgAt3: ndcgAtK(hybridIds, relevant, limit),
        noAnswerFalsePositiveRate: noAnswerFp,
      },
      vectorOnly: {
        recallAt3: recallAtK(vectorIds, relevant, limit),
        mrrAt3: mrrAtK(vectorIds, relevant, limit),
        ndcgAt3: ndcgAtK(vectorIds, relevant, limit),
        noAnswerFalsePositiveRate: null,
      },
      listRecency: {
        recallAt3: recallAtK(listIds, relevant, limit),
        mrrAt3: mrrAtK(listIds, relevant, limit),
        ndcgAt3: ndcgAtK(listIds, relevant, limit),
        noAnswerFalsePositiveRate: null,
      },
      formula:
        "Binary labels. Recall@3 = mean fraction of labeled relevant documents retrieved in top-3 per answerable query. " +
        "MRR@3 = mean over answerable queries of 1/rank of the first relevant doc in top-3 (0 when absent). " +
        "NDCG@3 = mean of DCG@3/IDCG@3 with DCG@3 = sum(rel_i / log2(i+1)) over top-3 positions i=1..3.",
    },
    thresholdTreatment: {
      hybrid: `Top-${limit} after filtering at the configured similarity threshold (production behavior).`,
      vectorOnly:
        "Rank-only: top-3 by content cosine with no threshold. No universal cosine cutoff is manufactured, so no-answer metrics are N/A.",
      listRecency:
        "Rank-only: newest-first insertion order (created_at desc, id asc), no threshold. No-answer metrics are N/A.",
    },
    timingsMs: {
      documentEmbeddingTotalMs,
      perQueryEmbed: {
        p50: percentileP(asc(embedTimes), 50),
        p95: percentileP(asc(embedTimes), 95),
      },
      perQueryRank: {
        p50: percentileP(asc(rankTimes), 50),
        p95: percentileP(asc(rankTimes), 95),
      },
      perQueryTotal: {
        p50: percentileP(asc(totals), 50),
        p95: percentileP(asc(totals), 95),
      },
      includesEmbeddingCalls:
        "perQueryTotal and perQueryEmbed include live remote embedding calls (fresh service, no cache hits expected); perQueryRank is in-memory scoring/sorting only.",
    },
    perQuery,
    limitations: [
      "In-memory linear scan over 12 fixture docs; does not measure Turso DB candidate recall, shard fan-out, or host prompt injection.",
      "Small synthetic fixture (12 docs, 15 queries): scores are noisy and not a benchmark; low scores are a finding, not a failure.",
      "Hybrid metrics use threshold-filtered top-3; hybridBeforeThresholdTop shows the raw shortlist and threshold decisions, but does not expose every candidate's rank.",
      "Remote embedding latency dominates totals and varies with network/service load.",
    ],
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

class EvaluationConfigurationError extends Error {}

async function main(): Promise<void> {
  // Refuse before any backend work unless a usable remote endpoint is
  // configured; never fall back to local CPU inference here.
  if (!CONFIG.embeddingApiUrl || !CONFIG.embeddingApiKey || isEmbeddingMisconfigured()) {
    throw new EvaluationConfigurationError(
      "Remote embedding service is not configured or is misconfigured; refusing to run (no local fallback, no model downloads)."
    );
  }
  if (CONFIG.embeddingStatus?.mode !== "remote" || CONFIG.embeddingStatus.ready !== true) {
    throw new EvaluationConfigurationError(
      "Remote embedding service is not in ready remote mode; refusing to run (no local fallback)."
    );
  }

  const fixtureUrl = new URL("./fixtures/retrieval-coding-facts.json", import.meta.url);
  const fixture = (await Bun.file(fixtureUrl).json()) as {
    version: string;
    documents: EvalDoc[];
    queries: EvalQuery[];
  };

  const service = new EmbeddingService();
  const warmupStart = performance.now();
  await service.warmup();
  const warmupMs = performance.now() - warmupStart;

  const evaluationStart = performance.now();
  const embed: EmbedFn = async (text, task) => {
    const vector = await service.embedWithTimeout(text, { task });
    if (vector.length !== CONFIG.embeddingDimensions || !vector.every(Number.isFinite)) {
      throw new Error("Invalid embedding vector");
    }
    return vector;
  };
  const report = await runEvaluation(
    fixture.documents,
    fixture.queries,
    embed,
    CONFIG.similarityThreshold
  );
  const evaluationTotalMs = performance.now() - evaluationStart;

  const roundTimings = {
    perQueryEmbed: {
      p50: round4(report.timingsMs.perQueryEmbed.p50),
      p95: round4(report.timingsMs.perQueryEmbed.p95),
    },
    perQueryRank: {
      p50: round4(report.timingsMs.perQueryRank.p50),
      p95: round4(report.timingsMs.perQueryRank.p95),
    },
    perQueryTotal: {
      p50: round4(report.timingsMs.perQueryTotal.p50),
      p95: round4(report.timingsMs.perQueryTotal.p95),
    },
    includesEmbeddingCalls: report.timingsMs.includesEmbeddingCalls,
    warmupMs: round4(warmupMs),
    documentEmbeddingTotalMs: round4(report.timingsMs.documentEmbeddingTotalMs),
    evaluationTotalMs: round4(evaluationTotalMs),
  };

  const output = {
    ...report,
    dataset: { ...report.dataset, version: fixture.version },
    config: {
      embeddingModel: CONFIG.embeddingModel,
      embeddingDimensions: CONFIG.embeddingDimensions,
      similarityThreshold: CONFIG.similarityThreshold,
      embeddingMode: "remote",
      limit: RETRIEVAL_EVAL_LIMIT,
      actualQueryCount: fixture.queries.length,
      actualDocumentCount: fixture.documents.length,
    },
    timingsMs: roundTimings,
    metrics: {
      hybrid: {
        recallAt3: round4(report.metrics.hybrid.recallAt3),
        mrrAt3: round4(report.metrics.hybrid.mrrAt3),
        ndcgAt3: round4(report.metrics.hybrid.ndcgAt3),
        noAnswerFalsePositiveRate: round4(report.metrics.hybrid.noAnswerFalsePositiveRate ?? 0),
      },
      vectorOnly: {
        recallAt3: round4(report.metrics.vectorOnly.recallAt3),
        mrrAt3: round4(report.metrics.vectorOnly.mrrAt3),
        ndcgAt3: round4(report.metrics.vectorOnly.ndcgAt3),
        noAnswerFalsePositiveRate: null,
      },
      listRecency: {
        recallAt3: round4(report.metrics.listRecency.recallAt3),
        mrrAt3: round4(report.metrics.listRecency.mrrAt3),
        ndcgAt3: round4(report.metrics.listRecency.ndcgAt3),
        noAnswerFalsePositiveRate: null,
      },
      formula: report.metrics.formula,
    },
    perQuery: report.perQuery.map((entry) => ({
      ...entry,
      hybridTop: entry.hybridTop.map((top) => ({ ...top, score: round4(top.score) })),
      hybridBeforeThresholdTop: entry.hybridBeforeThresholdTop.map((top) => ({
        ...top,
        score: round4(top.score),
      })),
      vectorOnlyTop: entry.vectorOnlyTop.map((top) => ({ ...top, score: round4(top.score) })),
      embedMs: round4(entry.embedMs),
      rankMs: round4(entry.rankMs),
    })),
  };

  console.log(JSON.stringify(output, null, 2));
  console.error(
    `retrieval-eval done: hybrid R@3=${output.metrics.hybrid.recallAt3} ` +
      `MRR@3=${output.metrics.hybrid.mrrAt3} NDCG@3=${output.metrics.hybrid.ndcgAt3} ` +
      `noAnswerFPR=${output.metrics.hybrid.noAnswerFalsePositiveRate} ` +
      `docs=${fixture.documents.length} queries=${fixture.queries.length} ` +
      `warmupMs=${round4(warmupMs)}`
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Upstream response bodies may contain credentials or request material.
    // Only our own configuration messages are safe to expose verbatim.
    console.error(
      error instanceof EvaluationConfigurationError
        ? `retrieval-eval failed: ${error.message}`
        : "retrieval-eval failed: remote embedding or evaluation failed; response details withheld"
    );
    process.exit(1);
  }
}

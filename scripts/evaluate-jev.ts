/**
 * Synthetic-only baseline versus Jev retrieval evaluation.
 *
 * Ranks the public synthetic fixture from retrieval-coding-facts.json with the
 * unchanged hybrid formula (same thresholded candidates as the baseline), then
 * reranks those candidates once per query through the real Jev adapter
 * (src/services/jev.ts). A separate fixed shortlist challenge from
 * fixtures/jev-relevance.json runs through the adapter without embeddings.
 *
 * Usage: bun scripts/evaluate-jev.ts > /var/tmp/james/opencode/jev-memory-evaluation.json
 *
 * Stdout is the JSON report only (ids, scores, metrics, statuses, latencies;
 * never URLs, keys, query text, or candidate content). Human progress goes to
 * stderr. Small live Jev calls use TYPESAFE_API_KEY; inputs are synthetic only.
 */
import { CONFIG } from "../src/config.js";
import { EmbeddingService, isEmbeddingMisconfigured } from "../src/services/embedding.js";
import { rerankWithJev } from "../src/services/jev.js";
import type { SearchResult } from "../src/services/turso/types.js";
import { formatTagsForEmbedding } from "../src/services/turso/vector-utils.js";
import {
  RETRIEVAL_EVAL_LIMIT,
  cosineSimilarity,
  hybridScoreForDoc,
  mrrAtK,
  ndcgAtK,
  percentileP,
  rankByScore,
  recallAtK,
} from "./evaluate-retrieval.js";
import type { EvalDoc, EvalQuery } from "./evaluate-retrieval.js";

const JEV_TIMEOUT_MS = 10_000;
const JEV_MAX_CANDIDATES = 24;

type ChallengeCandidate = { id: string; memory: string; hybridScore: number };
type ChallengeSet = {
  id: string;
  kind: string;
  rationale: string;
  query: string;
  candidates: ChallengeCandidate[];
  expectedRelevantIds: string[];
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function asc(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

class JevEvaluationConfigurationError extends Error {}

type CorpusPerQuery = {
  id: string;
  kind: string;
  answerable: boolean;
  relevantIds: string[];
  candidateCount: number;
  candidateRecall: number | null;
  baselineTop: Array<{ id: string; score: number }>;
  jevTop: Array<{ id: string; score: number; choice: string }>;
  jevStatus: string;
  jevReason: string | null;
  jevAssessed: number;
  jevAbstained: number;
  jevLatencyMs: number;
};

type ChallengePerSet = {
  id: string;
  kind: string;
  inputOrder: Array<{ id: string; hybridScore: number }>;
  outputOrder: Array<{ id: string; score: number; choice: string }>;
  expectedRelevantIds: string[];
  expectedRetained: number;
  expectedDropped: string[];
  unexpectedSurvivors: string[];
  jevStatus: string;
  jevReason: string | null;
  jevAssessed: number;
  jevAbstained: number;
  jevLatencyMs: number;
};

async function main(): Promise<void> {
  // Same refusal posture as evaluate-retrieval.ts: remote embeddings only,
  // never a local CPU fallback or model download.
  if (!CONFIG.embeddingApiUrl || !CONFIG.embeddingApiKey || isEmbeddingMisconfigured()) {
    throw new JevEvaluationConfigurationError(
      "Remote embedding service is not configured or is misconfigured; refusing to run (no local fallback, no model downloads)."
    );
  }
  if (CONFIG.embeddingStatus?.mode !== "remote" || CONFIG.embeddingStatus.ready !== true) {
    throw new JevEvaluationConfigurationError(
      "Remote embedding service is not in ready remote mode; refusing to run (no local fallback)."
    );
  }

  const corpusUrl = new URL("./fixtures/retrieval-coding-facts.json", import.meta.url);
  const corpus = (await Bun.file(corpusUrl).json()) as {
    version: string;
    documents: EvalDoc[];
    queries: EvalQuery[];
  };
  const challengeUrl = new URL("./fixtures/jev-relevance.json", import.meta.url);
  const challenge = (await Bun.file(challengeUrl).json()) as {
    version: string;
    sets: ChallengeSet[];
  };

  const apiKey = process.env.TYPESAFE_API_KEY ?? "";
  const service = new EmbeddingService();
  await service.warmup();

  const limit = RETRIEVAL_EVAL_LIMIT;
  const threshold = CONFIG.similarityThreshold;

  // Embed corpus documents exactly like evaluate-retrieval.ts main.
  const docVectors: Array<{ doc: EvalDoc; contentVec: Float32Array; tagsVec: Float32Array }> = [];
  for (const doc of corpus.documents) {
    const contentVec = await service.embedWithTimeout(doc.content, { task: "document" });
    const tagsVec = await service.embedWithTimeout(formatTagsForEmbedding(doc.tags), {
      task: "document",
    });
    if (
      contentVec.length !== CONFIG.embeddingDimensions ||
      tagsVec.length !== CONFIG.embeddingDimensions
    ) {
      throw new Error("Invalid embedding vector");
    }
    docVectors.push({ doc, contentVec, tagsVec });
  }

  const perQuery: CorpusPerQuery[] = [];
  const jevLatencies: number[] = [];
  let jevAssessedTotal = 0;
  let jevAbstainedTotal = 0;

  for (const query of corpus.queries) {
    const queryVec = await service.embedWithTimeout(query.text, { task: "query" });
    if (queryVec.length !== CONFIG.embeddingDimensions) throw new Error("Invalid query vector");

    // Unchanged hybrid scoring and unchanged threshold: apples to apples.
    const scored = docVectors.map(({ doc, contentVec, tagsVec }) => {
      const contentSim = cosineSimilarity(queryVec, contentVec);
      const tagsSim = cosineSimilarity(queryVec, tagsVec);
      const { score, components } = hybridScoreForDoc(
        contentSim,
        tagsSim,
        doc.content,
        doc.tags.join(","),
        query.text
      );
      return { id: doc.id, score, components, createdAt: doc.createdAt, memory: doc.content };
    });
    const ranked = rankByScore(scored);
    const thresholded = ranked.filter((entry) => entry.score >= threshold);

    const candidates: SearchResult[] = thresholded.map((entry) => ({
      id: entry.id,
      memory: entry.memory,
      similarity: entry.score,
      scoreComponents: entry.components,
      createdAt: entry.createdAt,
    }));

    // Report actual fallback, never success, on timeout or adapter error:
    // rerankWithJev already encodes that in its status/reason fields.
    const jev = await rerankWithJev(query.text, candidates, {
      enabled: true,
      timeoutMs: JEV_TIMEOUT_MS,
      maxCandidates: JEV_MAX_CANDIDATES,
      apiKey,
    });
    jevLatencies.push(jev.latencyMs);
    jevAssessedTotal += jev.assessed;
    jevAbstainedTotal += jev.abstained;

    const candidateIds = new Set(candidates.map((entry) => entry.id));
    const candidateRecall = query.answerable
      ? query.relevantIds.length === 0
        ? 0
        : query.relevantIds.filter((id) => candidateIds.has(id)).length / query.relevantIds.length
      : null;

    perQuery.push({
      id: query.id,
      kind: query.kind,
      answerable: query.answerable,
      relevantIds: query.relevantIds,
      candidateCount: candidates.length,
      candidateRecall,
      baselineTop: thresholded
        .slice(0, limit)
        .map((entry) => ({ id: entry.id, score: entry.score })),
      jevTop: jev.results.slice(0, limit).map((entry) => ({
        id: entry.id,
        score: entry.similarity,
        choice: entry.jev?.choice ?? "unassessed",
      })),
      jevStatus: jev.status,
      jevReason: jev.reason ?? null,
      jevAssessed: jev.assessed,
      jevAbstained: jev.abstained,
      jevLatencyMs: jev.latencyMs,
    });
    console.error(
      `jev-eval corpus: query=${query.id} candidates=${candidates.length} ` +
        `status=${jev.status}${jev.reason ? ` reason=${jev.reason}` : ""} ` +
        `assessed=${jev.assessed} abstained=${jev.abstained} latencyMs=${jev.latencyMs}`
    );
  }

  const answerable = perQuery.filter((entry) => entry.answerable);
  const noAnswer = perQuery.filter((entry) => !entry.answerable);
  const relevant = answerable.map((entry) => entry.relevantIds);
  const baselineIds = answerable.map((entry) => entry.baselineTop.map((top) => top.id));
  const jevIds = answerable.map((entry) => entry.jevTop.map((top) => top.id));
  const baselineFp =
    noAnswer.length === 0
      ? 0
      : noAnswer.filter((entry) => entry.baselineTop.length > 0).length / noAnswer.length;
  const jevFp =
    noAnswer.length === 0
      ? 0
      : noAnswer.filter((entry) => entry.jevTop.length > 0).length / noAnswer.length;

  const candidateRecallMean =
    answerable.length === 0
      ? 0
      : answerable.reduce((sum, entry) => sum + (entry.candidateRecall ?? 0), 0) /
        answerable.length;

  // Fixed shortlist challenge: no embeddings, adapter only, reported separately.
  // Labels are authored, not independently adjudicated; never a held-out benchmark.
  const challengeResults: ChallengePerSet[] = [];
  for (const set of challenge.sets) {
    const candidates: SearchResult[] = set.candidates.map((candidate) => ({
      id: candidate.id,
      memory: candidate.memory,
      similarity: candidate.hybridScore,
    }));
    const jev = await rerankWithJev(set.query, candidates, {
      enabled: true,
      timeoutMs: JEV_TIMEOUT_MS,
      maxCandidates: JEV_MAX_CANDIDATES,
      apiKey,
    });
    const outputIds = jev.results.map((entry) => entry.id);
    const expected = new Set(set.expectedRelevantIds);
    const outputSet = new Set(outputIds);
    challengeResults.push({
      id: set.id,
      kind: set.kind,
      inputOrder: set.candidates.map((candidate) => ({
        id: candidate.id,
        hybridScore: candidate.hybridScore,
      })),
      outputOrder: jev.results.map((entry) => ({
        id: entry.id,
        score: entry.similarity,
        choice: entry.jev?.choice ?? "unassessed",
      })),
      expectedRelevantIds: [...set.expectedRelevantIds],
      expectedRetained: set.expectedRelevantIds.filter((id) => outputSet.has(id)).length,
      expectedDropped: set.expectedRelevantIds.filter((id) => !outputSet.has(id)),
      unexpectedSurvivors: outputIds.filter(
        (id) => !expected.has(id) && set.expectedRelevantIds.length > 0
      ),
      jevStatus: jev.status,
      jevReason: jev.reason ?? null,
      jevAssessed: jev.assessed,
      jevAbstained: jev.abstained,
      jevLatencyMs: jev.latencyMs,
    });
    console.error(
      `jev-eval challenge: set=${set.id} status=${jev.status}` +
        `${jev.reason ? ` reason=${jev.reason}` : ""} latencyMs=${jev.latencyMs}`
    );
  }

  const report = {
    dataset: {
      corpusVersion: corpus.version,
      challengeVersion: challenge.version,
      documentCount: corpus.documents.length,
      queryCount: corpus.queries.length,
      answerableCount: answerable.length,
      noAnswerCount: noAnswer.length,
      challengeSetCount: challenge.sets.length,
    },
    config: {
      embeddingModel: CONFIG.embeddingModel,
      embeddingDimensions: CONFIG.embeddingDimensions,
      similarityThreshold: threshold,
      embeddingMode: "remote",
      limit,
      jevTimeoutMs: JEV_TIMEOUT_MS,
      jevMaxCandidates: JEV_MAX_CANDIDATES,
    },
    metrics: {
      cutoff: limit,
      baseline: {
        recallAt3: round4(recallAtK(baselineIds, relevant, limit)),
        mrrAt3: round4(mrrAtK(baselineIds, relevant, limit)),
        ndcgAt3: round4(ndcgAtK(baselineIds, relevant, limit)),
        noAnswerFalsePositiveRate: round4(baselineFp),
      },
      jev: {
        recallAt3: round4(recallAtK(jevIds, relevant, limit)),
        mrrAt3: round4(mrrAtK(jevIds, relevant, limit)),
        ndcgAt3: round4(ndcgAtK(jevIds, relevant, limit)),
        noAnswerFalsePositiveRate: round4(jevFp),
      },
      candidateRecallBeforeRerank: round4(candidateRecallMean),
      formula:
        "Binary labels over answerable corpus queries. Recall@3 = mean fraction of labeled relevant documents retrieved in top-3. " +
        "MRR@3 = mean of 1/rank of the first relevant doc in top-3 (0 when absent). " +
        "NDCG@3 = mean of DCG@3/IDCG@3. No-answer false positive rate = fraction of unanswerable queries returning anything in top-3. " +
        "Candidate recall = mean fraction of relevant docs present in the thresholded hybrid candidate set passed to Jev.",
    },
    jevAddedLatencyMs: {
      p50: round4(percentileP(asc(jevLatencies), 50)),
      p95: round4(percentileP(asc(jevLatencies), 95)),
      includesAdapterCalls:
        "Corpus per-query Jev adapter latency only (excludes embedding and hybrid ranking).",
    },
    jevTotals: {
      assessed: jevAssessedTotal,
      abstained: jevAbstainedTotal,
      statuses: perQuery.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.jevStatus] = (counts[entry.jevStatus] ?? 0) + 1;
        return counts;
      }, {}),
    },
    perQuery: perQuery.map((entry) => ({
      ...entry,
      candidateRecall: entry.candidateRecall === null ? null : round4(entry.candidateRecall),
      baselineTop: entry.baselineTop.map((top) => ({ ...top, score: round4(top.score) })),
      jevTop: entry.jevTop.map((top) => ({ ...top, score: round4(top.score) })),
    })),
    challenge: {
      note: "Authored fixed-shortlist probe, reported separately from corpus retrieval. Labels are authored expectations, not independently adjudicated; never a held-out or external benchmark. No claim of general retrieval quality follows from these sets.",
      sets: challengeResults.map((entry) => ({
        ...entry,
        inputOrder: entry.inputOrder.map((row) => ({
          ...row,
          hybridScore: round4(row.hybridScore),
        })),
        outputOrder: entry.outputOrder.map((row) => ({ ...row, score: round4(row.score) })),
      })),
    },
    limitations: [
      "Small synthetic corpus (12 docs, 15 queries): scores are noisy and not a benchmark; low scores are a finding, not a failure.",
      "Challenge labels are authored by the fixture writer without independent adjudication; agreement with them measures label-match, not retrieval quality.",
      "Jev latency includes live network calls and varies with service load.",
      "Jev fallback statuses (for example missing-key or request-failed) are reported as-is; a fallback row compares the unfiltered candidate order, not a rerank.",
      "No SOTA or external-benchmark claim follows from these fixtures.",
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  console.error(
    `jev-eval done: baseline R@3=${report.metrics.baseline.recallAt3} ` +
      `jev R@3=${report.metrics.jev.recallAt3} ` +
      `candidateRecall=${report.metrics.candidateRecallBeforeRerank} ` +
      `jevLatency p50=${report.jevAddedLatencyMs.p50} p95=${report.jevAddedLatencyMs.p95}`
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof JevEvaluationConfigurationError
        ? `jev-eval failed: ${error.message}`
        : "jev-eval failed: remote embedding, adapter, or evaluation failed; response details withheld"
    );
    process.exit(1);
  }
}

# Retrieval decisions and research

Research accessed 22 October 2026. This phase repairs known correctness defects; it is not a state-of-the-art performance claim.

## Decisions

1. **Use the authored query.** Automatic project context now calls the same scored search as explicit retrieval. Recent-memory listing is not relevance retrieval, and missing queries must not invent relevance. First mode keeps the first query's context for compatibility; always mode refreshes each authored prompt. A cold reload derives its query from the latest non-synthetic user message.
2. **Keep the score scale for this repair.** Text search retains `0.5 * content + 0.3 * tags + 0.2 * lexical coverage`; queryless vector search retains `0.6 * content + 0.4 * tags`. Scores are bounded retrieval heuristics, not confidence probabilities. Lexical coverage is repaired, so threshold calibration still needs checking on representative local queries after the change.
3. **Do not blindly replace calibrated scores with RRF.** OpenSearch documents that reciprocal rank fusion combines rank positions and discards score magnitudes. This makes it useful when component scores are incomparable, but does not establish superiority for this corpus. Our keyword feature is bounded coverage, not raw BM25. Evaluate RRF against the existing blend on held-out labels before changing thresholds or defaults. [1]
4. **Separate candidate retrieval from context packing.** Retrieve a bounded wider pool, then enforce project/session/age filters and exact-content deduplication before the final count. Whole memories and escaped provenance must fit the complete character budget. A character budget is not a token count. Exact deduplication deliberately does not erase merely similar or potentially contradictory facts.
5. **Measure retrieval and memory use separately.** BEIR lists Recall@k, NDCG@k and MRR@k as retrieval metrics. Small deterministic fixtures can prove regressions are fixed; they cannot establish real-world task accuracy or embedding quality. [2]
6. **Evaluate more than recall next.** LongMemEval covers information extraction, multi-session reasoning, knowledge updates, temporal reasoning and abstention, and supports turn/session indexing and recall evaluation. Those are useful test categories, not evidence that this coding plugin has matched its benchmark results. [3]

## Sources independently reopened

- [1] OpenSearch, [Reciprocal rank fusion](https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/rrf/), introductory definition and “Choosing a combination method” table. Rank-based fusion and loss of score magnitudes verified; no vendor benchmark numbers adopted.
- [2] BEIR, [Metrics available](https://github.com/beir-cellar/beir/wiki/Metrics-available), metric lists. Metric availability verified; our fixture labels remain authored local judgments.
- [3] LongMemEval, [original benchmark repository](https://github.com/xiaowu0162/longmemeval), Overview, Dataset Format and Memory Retrieval sections. Ability categories and turn/session evaluation support verified; no causal claim about granularity performance made.

## Explored, not adopted

The research also inspected the [BGE reranker model card](https://huggingface.co/BAAI/bge-reranker-v2-m3). A local shortlist reranker is a plausible experiment, but requires latency/quality measurements and a compatible GPU path. No new model is downloaded in this phase. Secondary vendor retrospectives and an abstract-only context-pruning paper were not used to justify performance claims.

## Evaluation and remaining limits

- The three-query synthetic fixture in `tests/hybrid-retrieval-eval.test.ts` yields Recall@2 of 3/3 for repaired ranking versus 1/3 for newest-first listing. Every labeled target is ranked first. All document vectors are deliberately identical to isolate lexical behavior; this does not measure embedding quality, latency or generalization.
- Regression cases cover the original list-based injection defect, identifier/punctuation handling, deterministic lexical candidate recall, scope/session/age filtering, hostile markup and budget limits.
- Wider candidate pools are still bounded; heavy filtering can return fewer memories than requested. This is safer than filling context with unscored entries.
- The final memory count is now enforced after whole-entry budget fits, so later smaller candidates refill slots skipped by oversized entries. V2 configuration fingerprints invalidate existing caches and reject old in-flight loads; the first/always policy remains otherwise unchanged.
- Lexical boundaries now recognize Unicode letters, marks and numbers (including supplementary-plane characters), with NFC normalization and full/camelCase/acronym symbol matching. This is not CJK segmentation, stemming or full Unicode case folding.
- A scoped lexical scan trades linear work for deterministic coverage at the current small corpus size; measure before scaling it to much larger stores.
- Escaping markup and labeling reference data reduces structural prompt injection, but cannot make an LLM immune to malicious prose. Memories remain untrusted data, never authorization.
- Next experiments need independently labeled real coding queries, no-answer cases, correction/supersession cases, retrieval metrics at fixed k, context cost, latency and downstream task outcomes. Compare a pinned baseline, hybrid repair, RRF and optional reranking without tuning and scoring on the same labels.

## Real-embedding evaluation

Run `bun scripts/evaluate-retrieval.ts` from the repository root. The script refuses local CPU fallback and model downloads, uses only the existing configured remote embedding service, and ranks public synthetic coding facts in memory. It does not open or write a memory database. Fixture labels are fixed in `scripts/fixtures/retrieval-coding-facts.json`; a new service instance avoids prior embedding-cache hits. No threshold is tuned by the script.

Measured on 22 October 2026 with `onnx-community/embeddinggemma-2-ONNX`, 768 dimensions and configured hybrid threshold 0.58: 12 documents, 12 answerable queries and 3 no-answer queries, cutoff 3.

| System                          | Recall@3 |  MRR@3 | NDCG@3 | No-answer false positives |
| ------------------------------- | -------: | -----: | -----: | ------------------------- |
| Hybrid, configured threshold    |   0.9167 | 0.9167 | 0.9167 | 0/3                       |
| Content cosine, rank only       |   1.0000 | 0.8889 | 0.9167 | N/A: no calibrated cutoff |
| Newest-first listing, rank only |   0.1667 | 0.0694 | 0.0942 | N/A: no calibrated cutoff |

One coordinator run measured total query p50 53.27 ms and p95 56.20 ms, including remote query embedding; rank-only p50 was 3.23 ms. Document embedding took 1201 ms separately from query evaluation. These are tiny in-memory timings, not database or host-injection latency.

The French installation paraphrase is the hybrid miss: the labeled document is third by content cosine but outside the hybrid raw top three, and the hybrid shortlist is below the configured threshold. Both ranking and threshold behavior need representative multilingual evaluation; simply lowering a cutoff is not a demonstrated fix. Per-query raw/filtered hybrid shortlists and scores are emitted so threshold decisions are visible.

This small synthetic set is a regression aid, not a held-out corpus or an external benchmark. Hybrid and rank-only baselines have different threshold treatment, so the table is not an apples-to-apples claim that one ranker is universally superior. No-answer accuracy on three examples has large uncertainty. End-to-end task quality, Turso candidate recall and running-host injection remain outside this measurement.

## Jev decision reranking

Primary sources read on 31 October 2026. This is a measured second-stage upgrade,
not a claim of state-of-the-art end-to-end memory performance. Web-search discovery
was unavailable, and the research worker failed with a provider tool-choice
incompatibility. The coordinator directly read eight public primary pages; these
claims are self-checked, not independently verified literature findings.

### Evidence and integration decisions

1. **Use decisions, not generated summaries.** TypeSafe's [introduction](https://docs.typesafe.ai/introduction)
   describes typed questions evaluated against a shared state and recommends atomic,
   well-scoped judgments. Keep the existing generative auto-capture and embedding
   pipeline. Ask one relevance question per candidate, in a single batch.
2. **Pin the version and validate the whole response.** The [model reference](https://docs.typesafe.ai/models)
   identifies Jev 1.14 as the newest release, available from 14 October 2026, and
   warns that aliases move. The [API reference](https://docs.typesafe.ai/api/system-one)
   and [quickstart](https://docs.typesafe.ai/introduction/quickstart) specify bearer
   authentication, state/model/questions and named answers. The existing key
   completed a synthetic `jev-1.14.0` request with HTTP 200 in 433 ms; this is one
   probe, not an availability or latency guarantee.
3. **Keep probabilities distinct from confidence and retrieval scores.** The
   [Choice reference](https://docs.typesafe.ai/primitives/choice#response-structure)
   defines the selected option as the highest-probability option and returns the
   full distribution. The [confidence reference](https://docs.typesafe.ai/confidence#choice)
   computes Choice confidence as `(max(p) - 1/n) / (1 - 1/n)`. The live probe
   returned probability 0.87 and confidence 0.8, consistent with rounded values for
   three choices. Neither is a measured correctness guarantee for our corpus.
4. **Retain uncertainty and relevant contradictions.** The confidence guide says,
   “The correct threshold values depend on your domain and the performance of the
   model for your use case.” The initial conservative omission rule requires an
   irrelevant choice, probability at least 0.9 and confidence at least 0.8, with
   neither query nor candidate truncated. These are policy starting points, not
   calibrated operating points. Unknown evidence and unassessed tails survive.
5. **Bound state and keep deterministic safeguards in code.** TypeSafe's
   [Jev 1.13 jaggedness report](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
   explicitly warns about literal reading, indirection, adversarial state, long
   irrelevant context and unreliable date comparisons. That report applies to
   1.13, not a verified defect inventory for 1.14; it motivates tests rather than
   proving 1.14 has the same failures. Scope, age, session exclusion, thresholds,
   deduplication, character budgets and chronological provenance stay in code.
   A relevance decision does not determine which contradictory statement is true.
6. **Minimize remote data, do not imply zero retention.** The model reference says
   customer requests/responses are not used for training, but refers specifically
   to enterprise ZDR. No account-specific retention or ZDR guarantee was verified.
   Opt-in sends query/candidate excerpts, not original metadata fields; private
   markers and the configured key are stripped. Arbitrary secrets embedded in
   unmarked prose are not automatically detected. English is the documented best
   supported language; multilingual quality requires measurement.
7. **Evaluate memory capabilities, not vendor slogans.** The original
   [LongMemEval repository](https://github.com/xiaowu0162/LongMemEval#-longmemeval-overview)
   names information extraction, multi-session reasoning, knowledge updates,
   temporal reasoning and abstention. Its labels distinguish turn/session recall
   from answer evaluation. It also links a newer agentic V2 benchmark; that V2
   benchmark was not evaluated here. Our small fixtures cover selected categories,
   not the full benchmark or downstream task success.

### Operational bounds

- Disabled by default; uses the existing server-side `TYPESAFE_API_KEY` only.
- Global configuration only; project-local configuration cannot opt a machine
  into remote inference. Explicit all-projects searches can send excerpts from
  other projects, still without separate metadata fields.
- Defaults: 12 assessed candidates and 2500 ms. Maximum 24; one request, no retries.
- Excerpts: query at most 8000 characters, each memory at most 2000. Serialized
  requests above 48 KiB fall back; streamed responses are capped at 128 KiB.
- Fixed endpoint with redirects refused; full answer-key/model/distribution
  validation; sanitized failure codes, no remote error bodies or input logging.
- Hybrid thresholds, original scores and provenance remain unchanged. This cannot
  recover evidence already missed or excluded by first-stage retrieval.
- Stored memories are never modified by reranking. Prompt-injection resistance
  is not guaranteed by rubrics or typed output; assessments grant no authority.
- The serialized-byte ceiling can force baseline fallback for large CJK/emoji
  shortlists even below the character limits. Adaptive fitting is a follow-up,
  not grounds for relaxing the outbound bound.

### Reproducible evaluation

Run `bun scripts/evaluate-jev.ts` with the existing TypeSafe key and configured
remote embedding service. It compares the same thresholded hybrid candidates
before/after Jev and reports Recall@3, MRR@3, NDCG@3, candidate recall, no-answer
false positives, fallback counts and added latency. A separate authored shortlist
challenge exercises negation, history, multilingual queries, distractors,
unanswerable queries and hostile prose. Neither fixture is held out or independently
adjudicated, and neither writes production memories. Measurements follow below.

Coordinator live run with EmbeddingGemma 2, 768 dimensions, threshold 0.58 and
`jev-1.14.0`: 12 documents, 15 corpus queries (12 answerable), cutoff 3. The
evaluation allows 24 assessed candidates and a 10-second deadline, versus the
runtime defaults of 12 and 2.5 seconds; this corpus never supplied more than eight
candidates to a call, and the longest measured adapter call was 130 ms.

| Metric                         | Hybrid baseline | Hybrid + Jev |
| ------------------------------ | --------------: | -----------: |
| Recall@3                       |          0.9167 |       0.9167 |
| MRR@3                          |          0.9167 |       0.9167 |
| NDCG@3                         |          0.9167 |       0.9167 |
| No-answer false positives      |             0/3 |          0/3 |
| Candidate entries after filter |              50 |           37 |

Jev assessed 50 candidates across 11 nonempty queries and omitted 13 (26% of the
assessed entries). This is a shortlist reduction, not a measured token-cost or
task-success improvement. The French query's relevant document was already
excluded by hybrid retrieval: candidate recall remained 0.9167. Four empty pools
(that miss plus three unanswerable queries) made no HTTP call and are currently
reported as `fallback/input-limit`, not as successful reranks.

Across all 15 adapter invocations, including those four zero-work calls, added
latency was p50 80 ms and p95 130 ms. Among the 11 nonempty calls alone, p50 was
91 ms and p95 130 ms. These are small-run network measurements, not an SLA.

All expected evidence survived in the six answerable authored challenge sets;
the unanswerable set returned no candidates. One hostile instruction candidate
was classified irrelevant but retained because it did not satisfy the conservative
omission rule. Do not interpret this as prompt-injection immunity or perfect
precision. History/correction relevance is preserved, not resolved into current
truth. No criteria or fixture labels were tuned after observing results.

An initial experiment sorted within the relevant class by its probability and
reduced MRR@3 from 0.9167 to 0.875. That policy was rejected: certainty of class
membership is not graded usefulness. The shipped policy preserves baseline order
within each class, guarded by a focused regression test. The corrected run is a
development evaluation, not an independent held-out validation.

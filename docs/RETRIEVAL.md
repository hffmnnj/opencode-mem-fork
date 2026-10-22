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
- A scoped lexical scan trades linear work for deterministic coverage at the current small corpus size; measure before scaling it to much larger stores.
- Escaping markup and labeling reference data reduces structural prompt injection, but cannot make an LLM immune to malicious prose. Memories remain untrusted data, never authorization.
- Next experiments need independently labeled real coding queries, no-answer cases, correction/supersession cases, retrieval metrics at fixed k, context cost, latency and downstream task outcomes. Compare a pinned baseline, hybrid repair, RRF and optional reranking without tuning and scoring on the same labels.

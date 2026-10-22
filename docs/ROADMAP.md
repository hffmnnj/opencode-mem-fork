# Memory quality roadmap

## Done: cache-stable memory context

- Move the existing quoted memory payload to the request tail without changing recall, profiles, refresh, suppression, configuration invalidation or race protection.
- No new persistence, model calls, feature removal or service restart. Verify native message compatibility and unchanged prior-prefix bytes.
- Coordinator verified 24 focused tests, typecheck, touched-file format/lint, non-destructive TypeScript emit and native OpenAI/Anthropic cross-plugin lowering. One integrated independent review passed; the live watcher subscribed to the new compiled tail helper and the plugin remained active in three checked locations.

## Done: deterministic hybrid ranking

- Commit `1b5a9f7` repairs lexical candidate truncation and hydration scoring, keeps actual components/provenance, and stabilizes ties.
- Local ranking checks: 20 tests pass. Three-query synthetic regression fixture: Recall@2 3/3 versus 1/3 for newest-first listing; all three ranked first. This is not an embedding-quality or external benchmark.
- Primary retrieval/evaluation sources researched; three central claims independently reopened and qualified in RETRIEVAL.md.

## Done: query-driven context integration

- Automatic injection searches authored project queries, applies real scores/thresholds, and recovers cold queries without synthetic capture.
- Context is bounded and deduplicated, with escaped text, IDs, dates and source sessions. Explicit search exposes raw scores/components and accurate returned counts.
- One injection-boundary review passed the product criteria; its prompt-ordering race was reproduced and fixed with a deferred-promise regression test.
- Full suite: 832 pass, 4 skip, 0 fail, plus 31 selector/formatter tests in an isolated child. Repository check (format/lint/typecheck), runtime build, packaging checks and Node import pass. A pre-existing one-line formatting issue was corrected to make the repository check pass.
- Live explicit memory search returned varying scores after the build. Current host injection/code reload has not been observed; no server restart or synthetic session was used.

## Done: phase 2

- Packing counts only successfully fitted memories and refills from lower candidates; a real-plugin regression covers an oversized top memory with two smaller survivors.
- Lexical matching uses NFC, Unicode boundaries (including supplementary-plane letters) and camelCase/acronym components within 16 terms.
- Configuration-sensitive V2 caches invalidate between model calls and reject old in-flight loads. One independent cache-race review passed; the actual CONFIG-object-replacement branch remains code-reviewed rather than directly exercised by the new fixture.
- Added a no-database real-embedding evaluation: 12 public synthetic facts, 15 fixed queries, configured Gemma 2 remote embeddings and threshold 0.58. Hybrid Recall@3 11/12, no-answer false positives 0/3; vector-only rank Recall@3 12/12. The French paraphrase miss and baseline threshold differences are documented in RETRIEVAL.md; no production threshold was retuned.
- Full suite: 859 pass, 4 skip, 0 fail, plus 36 selector/formatter tests in an isolated child. Repository check, build, Node import and compiled packing pass. No production memory rows were written by the evaluation.

## Published

- [PR #3](https://github.com/hffmnnj/opencode-mem-fork/pull/3) is open against `main` from `feat/query-driven-memory`, covering both upgrade phases. Not merged.

## Next phases

- Evaluate retrieval on a larger independently labeled, held-out coding corpus with multilingual queries and harder abstention cases; the small real-embedding fixture is not sufficient for tuning or SOTA claims.
- Compare calibrated hybrid scoring with rank fusion and optional reranking before changing defaults.
- Assess memory write quality, contradiction/supersession handling and privacy on real labeled examples.
- Measure end-to-end task quality, latency and context cost against a pinned baseline.
- Align V1 internal-capture gating with V2, and add a direct client project-search shard traversal assertion.
- Add benchmark-backed improvements incrementally; do not equate benchmark vendor claims with our fork's performance.

## Delivery constraints

- Existing live memory data is not modified by this phase.
- Existing OpenCode server stays running; source/build verification is not proof of plugin hot reload.
- Publish to hffmnnj/opencode-mem-fork with explicit base main (the remote default points elsewhere).

# Memory quality roadmap

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

## Published

- [PR #3](https://github.com/hffmnnj/opencode-mem-fork/pull/3) is open against `main` from `feat/query-driven-memory`; ranking and context changes are committed as `1b5a9f7` and `aa24d89`. Not merged.

## Next phases

- Evaluate retrieval on representative coding tasks and abstention cases, not just synthetic vectors.
- Compare calibrated hybrid scoring with rank fusion and optional reranking before changing defaults.
- Assess memory write quality, contradiction/supersession handling and privacy on real labeled examples.
- Measure end-to-end task quality, latency and context cost against a pinned baseline.
- Align V1 internal-capture gating with V2, and add a direct client project-search shard traversal assertion.
- Add benchmark-backed improvements incrementally; do not equate benchmark vendor claims with our fork's performance.

## Delivery constraints

- Existing live memory data is not modified by this phase.
- Existing OpenCode server stays running; source/build verification is not proof of plugin hot reload.
- Publish to hffmnnj/opencode-mem-fork with explicit base main (the remote default points elsewhere).

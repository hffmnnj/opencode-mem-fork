# Query-driven memory, phase 1

## Phase 2: packing, query matching and measurement

Goal: spend the context budget on useful complete memories, recognize multilingual and code-symbol queries, respect live configuration changes, and measure retrieval with the configured real embedding service.

Not doing: no new model/service, schema migration, production-memory rewrite, automatic contradiction deletion, or unmeasured ranking default switch.

Acceptance checks:

1. Oversized higher-ranked memories do not prevent smaller later candidates from filling the configured final count; the complete character bound and whole-memory guarantee remain.
2. Unicode word boundaries and NFC normalization prevent partial-word false matches; camelCase and acronym identifiers retain full-form and component recall within the existing 16-term bound.
3. V2 caches invalidate when retrieval/context configuration changes, including between model calls; in-flight old loads cannot restore stale context, and first/always policy remains unchanged otherwise.
4. A repeatable local evaluation uses real configured remote embeddings on public synthetic coding facts; reports fixed-k retrieval, abstention, latency and baseline comparisons without tuning the configured threshold or touching real memory stores.
5. Focused tests, repository checks, runtime-compatible build and an updated topic PR pass. Actual live observations remain separate from isolated evidence.

## Goal

Make automatic memory useful to the current request, with honest scores and bounded, attributable context. Improve lexical retrieval without replacing the calibrated hybrid score scale.

## Not doing in this phase

- No claim of state-of-the-art performance without an external benchmark.
- No database migration, automatic deletion, model replacement, or OpenCode restart.
- No new model service, graph database, or UI redesign.

## Acceptance checks

1. Injection searches the authored user query in the project scope and applies the configured relevance threshold; it never substitutes a recent-memory list.
2. Empty, internal and injected-only prompts do not retrieve project knowledge; reload does not invent a query.
3. Scores are actual bounded hybrid scores, not confidence percentages; IDs, dates and session provenance survive retrieval.
4. Selection rejects current-session, expired and duplicate memories before the final count and fits a configurable character budget including formatting.
5. Lexical recall is deterministic, handles punctuation and code identifiers, and scores hydrated candidates consistently without SQL wildcard expansion.
6. Behavioral regression tests and a small labeled retrieval evaluation run, with explicit limitations; typecheck, repository checks and a non-destructive runtime build are attempted.
7. A topic PR documents measured outcomes, sources and follow-ups. Live host behavior is distinguished from isolated test behavior.

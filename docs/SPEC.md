# Query-driven memory, phase 1

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

# Local fork rollout

The configured local plugin entrypoint is `index.js`, which imports `dist/plugin.js`. TypeScript source changes alone do not prove the running host is using them.

## Build without deleting the existing distribution

From the repository root:

```sh
bun run typecheck
bunx tsc
bun run web:build
bun test tests/plugin-root-entrypoint.test.ts tests/plugin-v2-loader-contract.test.ts
```

Do not use `bun run build` for this workflow: its current script recursively deletes `dist` before rebuilding. Emitting TypeScript in place avoids that deletion. This phase does not change web source, but the web build checks packaging compatibility.

## Runtime check

The existing OpenCode service must stay running. Do not launch an alternate host or create synthetic sessions to test injection. After a normal user prompt causes the host to load the updated local plugin, inspect its memory block: it should contain `score` and `score_kind="hybrid"`, memory IDs and dates, not `relevance="100%"`. A zero-result query may omit project knowledge; it must not inject a recent-memory list instead.

Configuration is hot-reloaded separately from code. Set `chatMessage.maxContextChars` to `0` to disable memory context, or `chatMessage.enabled` to `false` to disable the existing chat-message integration. Keep the configured GPU embedding endpoint; do not enable CPU fallback to test this change.

## Rollback

Keep the previous Git revision available. Rebuild a reviewed revert of this change on the topic branch if needed; do not reset the checkout or overwrite concurrent work. No memory rows, embeddings, schema or model are migrated by this phase.

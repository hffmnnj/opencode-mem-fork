# Local fork rollout

The configured local plugin entrypoint is `index.js`, which imports `dist/plugin.js`. TypeScript source changes alone do not prove the running host is using them.

## Build without deleting the existing distribution

From the repository root:

```sh
bun run typecheck
bunx tsc
bun run gui:build
bun run web:build
bun test tests/plugin-root-entrypoint.test.ts tests/plugin-v2-loader-contract.test.ts
```

Do not use `bun run build` for this workflow: its current script recursively deletes `dist` before rebuilding. Emitting TypeScript in place avoids that deletion. This phase does not change web source, but the web build checks packaging compatibility.

## Runtime check

### Durable capture and restoration

New automatic captures include `captureVersion: 2`, `memoryKind`, `sourceMessageId`
and exact `evidence` excerpts with their source roles. Inspect a normal capture or
explicit search response to distinguish active durable capture from an older
Request/Outcome summary. Source citations are not independent verification.

Legacy auto-capture rows remain explicitly searchable as `historical`; they are
not rewritten, re-embedded or deleted. Automatic context and compaction exclude
them. Manual and imported reference knowledge remains eligible. Until a project
has new durable captures or manual knowledge, its automatic context can be empty.

V2 compaction restoration must appear only through the existing branded request
tail. It must not create another Restored Session Memory user turn. Old restoration
turns already in the transcript remain unchanged but cannot become capture or
retrieval input. Provider cache-key construction and fixed system/history prefixes
are unchanged; a different memory payload is not a different cache key.

### GUI injection inspector

Build the additional Desktop entry without deleting the distribution:

```sh
bun run gui:build
```

The package exports `./gui-experimental` from `dist/gui-experimental.cjs`.
Desktop must load the plugin from its own background server. A browser connected
to a separate server is not proof that Desktop has loaded the plugin. Use a GUI
release supporting the experimental SDK; do not restart or upgrade the existing
main server merely to test the panel.

After an ordinary model request, open **Memory** from the session header or side
panel's **+** menu. Confirm its timestamp updates and its selectable raw text is
the latest context-hook attachment. Switching sessions must clear the previous
session's content. Empty, suppressed and disabled attachments must not leave old
memory text on screen. Plugin reload intentionally clears the in-memory inspector.

The existing OpenCode service must stay running. Do not launch an alternate host or create synthetic sessions to test injection. After a normal user prompt causes the host to load the updated local plugin, inspect its memory block: it should contain `score` and `score_kind="hybrid"`, memory IDs and dates, not `relevance="100%"`. A zero-result query may omit project knowledge; it must not inject a recent-memory list instead.

Configuration is hot-reloaded separately from code. Set `chatMessage.maxContextChars` to `0` to disable memory context, or `chatMessage.enabled` to `false` to disable the existing chat-message integration. Keep the configured GPU embedding endpoint; do not enable CPU fallback to test this change.

## Rollback

For the optional Jev layer, set `"jev": { "enabled": false }` in the effective
`opencode-mem.jsonc`. This restores the baseline search without changing memory
rows or the embedding model. Configuration reload invalidates automatic context.
The API key must already exist as `TYPESAFE_API_KEY` in the server process; an
export in a different terminal does not update a running process. Never paste
the key into configuration or diagnostics. Do not restart OpenCode to test this.

Run `bun scripts/evaluate-jev.ts` for a live, public-synthetic-only comparison.
It never opens the memory database and refuses local embedding model fallback.
Its authored labels are a regression aid, not an external benchmark. Confirm
`reranking.status` in a normal explicit memory search to distinguish active Jev
from baseline fallback; successful compilation alone does not establish activation.

Keep the previous Git revision available. Rebuild a reviewed revert of this change on the topic branch if needed; do not reset the checkout or overwrite concurrent work. No memory rows, embeddings, schema or model are migrated by this phase.

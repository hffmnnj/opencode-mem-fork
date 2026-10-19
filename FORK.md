# opencode-mem-fork — local fork of `opencode-mem` v2.32.0

Upstream: https://github.com/tickernelz/opencode-mem (tag `v2.32.0`, commit `60ae1a2`).
Installed as a local `file://` plugin in `~/.config/opencode-v2/opencode.json`, replacing
`opencode-mem@2.32.0`.

## Why this fork exists

Upstream v2.32.0 has three defects that bit us in production, plus a missing
operational property.

### F1 — Migration detector compares dimensions only (silent model swap)

`src/services/migration-service.ts` `detectDimensionMismatch()` compared
`storedDimensions !== CONFIG.embeddingDimensions` and ignored the stored model
name. Every model we use is 768-dimensional (`nomic-embed-text-v1` and
`embeddinggemma-2-ONNX` alike), so swapping the model was invisible:
`migrateToNewModel("re-embed")` reported success while re-embedding nothing,
and the store ended up holding vectors from two incomparable spaces.

**Fix:** compare the model name as well as the dimension count.

### F2 — Re-embed drops `session_id`

The staging `SELECT` in `migrateToNewModel()` did not list `session_id`, so the
staged rows lost it. We had to restore 1383 `session_id` values from a backup
by hand after a migration.

**Fix:** select `session_id` and carry it into the staged record.

### F3 — A bad secret takes down the whole plugin

`buildConfig()` called `resolveSecretValue()` unguarded. A config naming an
unset environment variable (`"embeddingApiKey": "env://MEM_EMBED_API_KEY"`)
made `initConfig()` throw inside plugin `setup()`. The plugin then failed to
load, which took down the web server (port 4747 went unbound) and unregistered
the `memory` tool — a total memory outage from one bad config line.

**Fix:** resolve secrets defensively. An unresolvable secret is reported as a
configuration problem but does not abort plugin setup.

### F4 — No hot reload

Two levels of hot reload were missing; both are required so that changing
memory configuration never requires restarting OpenCode.

**F4a — Plugin config is read once per process.** `CONFIG` was a module-level
`export let` assigned at import time and refreshed only by `initConfig()`,
which ran once per plugin setup. Editing `~/.config/opencode/opencode-mem.jsonc`
therefore had no effect on the running process: we changed `similarityThreshold`
and `embeddingApiUrl` and nothing happened until the process was restarted.

**Fix:** watch the plugin's config files and re-run `initConfig()` on change.
The watcher lives in `src/services/config-watcher.ts` and takes its
dependencies by injection. It deliberately does not import `config.ts`, and
`config.ts` does not re-export it: a two-way import between them breaks
module linking under Bun, and several upstream test fixtures replace
`config.js` with a partial stub, so plugin setup must not depend on new
exports from it. The wiring lives in `src/services/config-hot-reload.ts`.

**F4b — Plugin code changes required a restart.** With the plugin installed as
a package, editing the plugin's source did nothing to the running server.

**Fix:** install as a local `file://` plugin, which OpenCode's plugin
supervisor reloads when the plugin's files change.

## Module layout

```
src/config.ts                     config loading, buildConfig, secret resolution
src/services/config-paths.ts      config file locations (shared, no deps)
src/services/config-watcher.ts    fs.watch wrapper, dependency-injected
src/services/config-hot-reload.ts wiring between the watcher and config.ts
src/services/embedding.ts         remote/local embedding backend
src/services/migration-service.ts model-change detection, re-embed
```

## Operational requirement: embeddings always on GPU

The local ONNX path runs on CPU (onnxruntime-node has no CUDA build), which
saturates the machine. Embeddings must go to the GPU service.

`embeddingApiUrl` + `embeddingApiKey` select the remote path, and `embed()`
branches on those at call time, so the remote path is used as soon as `CONFIG`
is refreshed. The GPU service
(`http://127.0.0.1:4788`) serves the _same_ `onnx-community/embeddinggemma-2-ONNX`
model through onnxruntime's CUDA execution provider, and was verified
equivalent to the plugin's own embedder (cosine 1.000000, max component
difference 6.3e-5), so stored and freshly computed vectors stay in one space.

With F4a in place, switching between the CPU and GPU paths is a config edit,
not a restart.

A configured-but-unusable remote endpoint is a hard error, not a fallback:
the plugin refuses the local CPU model and reports the misconfiguration
through `CONFIG.embeddingStatus` and the log. The local ONNX path saturates
the machine, so silently degrading to it is worse than failing loudly.

## Invariants

- The store is one embedding space. `similarityThreshold` is 0.8 because
  unrelated content already sits at 0.71-0.79 cosine in the Gemma space.
- The plugin must load even when its config is partly broken (F3).
- A config edit must take effect without restarting OpenCode (F4a).
- `session_id` must survive a re-embed (F2).
- A model swap must be detected (F1).

## Verification

- `bun test` — upstream suite plus fork-specific tests. Baseline on the
  unmodified import: 782 pass, 4 skip, 0 fail.
- `bunx tsc --noEmit` — typecheck.
- `python3 ~/.config/opencode-v2/scripts/mem-verify.py` — store acceptance
  harness (A2-A7), currently OVERALL PASS.
- `python3 ~/.config/opencode-v2/scripts/mem-audit.py` — per-shard audit,
  currently OVERALL PASS.

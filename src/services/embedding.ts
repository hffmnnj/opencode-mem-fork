import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatOnnxruntimeInitError,
  prepareOnnxruntimeForTransformers,
} from "./onnxruntime-resolve.js";
import { createRuntimeRequire } from "./runtime-require.js";

const requireFromHere = createRuntimeRequire(import.meta);

const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");
const MAX_CACHE_SIZE = 100;
/**
 * Per-attempt ceiling for one remote embedding HTTP call. Kept at 8s so
 * 3 attempts + linear backoff stay under the outer embedWithTimeout budget
 * (TIMEOUT_MS = 30s). A single hung request costs one attempt instead of the
 * whole budget (#400: one transient hang previously aborted an entire import
 * with zero memories written).
 */
const REMOTE_ATTEMPT_TIMEOUT_MS = 8000;
/** Attempts per remote embedding call: 1 try + 2 retries on transient failures. */
const REMOTE_MAX_ATTEMPTS = 3;
/** Base backoff between remote embedding attempts; scales linearly (backoffMs * attempt). */
const REMOTE_RETRY_BACKOFF_MS = 500;
/**
 * Base delay before a failed remote warmup probe may be retried; scales
 * linearly with consecutive failures up to REMOTE_WARMUP_RETRY_MAX_MS, so a
 * down GPU service causes bounded fail-fast errors instead of a probe storm
 * or permanent death.
 */
const REMOTE_WARMUP_RETRY_BASE_MS = 5000;
/** Ceiling for the remote re-probe delay. */
const REMOTE_WARMUP_RETRY_MAX_MS = 60000;

// ONNX weight variants in descending precision, mirroring transformers.js
// DEFAULT_DTYPE_SUFFIX_MAPPING (utils/dtypes.js). fp32 has no filename suffix.
const ONNX_DTYPE_VARIANTS = [
  ["fp32", ""],
  ["fp16", "_fp16"],
  ["q8", "_quantized"],
  ["int8", "_int8"],
  ["uint8", "_uint8"],
  ["q4", "_q4"],
  ["q4f16", "_q4f16"],
  ["bnb4", "_bnb4"],
  ["q2", "_q2"],
  ["q2f16", "_q2f16"],
  ["q1", "_q1"],
  ["q1f16", "_q1f16"],
] as const;

/** Concrete dtype strings accepted by transformers.js `pipeline({ dtype })`. */
export type LocalOnnxDtype = (typeof ONNX_DTYPE_VARIANTS)[number][0] | "auto";

type DeclaredDtype =
  { kind: "string"; value: LocalOnnxDtype } | { kind: "object" } | { kind: "absent" };

function modelCacheRoot(model: string, cacheRoot?: string): string {
  return join(cacheRoot ?? join(CONFIG.storagePath, ".cache"), model);
}

/**
 * Read `transformers.js_config.dtype` from the cached config.json.
 * String declarations outrank the cache probe. Object (per-file) maps must not
 * be overridden — transformers.js resolves them after loading config. Absent or
 * malformed configs fall through to the cache probe.
 */
function readDeclaredDtype(model: string, cacheRoot?: string): DeclaredDtype {
  try {
    const parsed = JSON.parse(
      readFileSync(join(modelCacheRoot(model, cacheRoot), "config.json"), "utf-8")
    );
    const declared = parsed?.["transformers.js_config"]?.dtype;
    if (typeof declared === "string" && declared.trim()) {
      return { kind: "string", value: declared.trim() as LocalOnnxDtype };
    }
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      return { kind: "object" };
    }
    return { kind: "absent" };
  } catch {
    return { kind: "absent" };
  }
}

/**
 * Resolve the dtype whose ONNX weights are already cached, so a quantized-only
 * repo is not asked for `model.onnx` (fp32). Returns undefined when nothing is
 * cached yet — transformers.js then falls back to its own defaults.
 */
function detectCachedDtype(model: string, cacheRoot?: string): LocalOnnxDtype | undefined {
  const onnxDir = join(modelCacheRoot(model, cacheRoot), "onnx");
  const hit = ONNX_DTYPE_VARIANTS.find(([, suffix]) =>
    existsSync(join(onnxDir, `model${suffix}.onnx`))
  );
  return hit?.[0];
}

/**
 * Resolve a concrete dtype to pass into transformers.js `pipeline()`, or
 * undefined to leave dtype selection to transformers.js defaults / config.
 *
 * @param model Hugging Face model id (cache subdirectory under `.cache`)
 * @param cacheRoot Optional override for `{storagePath}/.cache` (tests)
 */
export function resolveLocalOnnxDtype(
  model: string,
  cacheRoot?: string
): LocalOnnxDtype | undefined {
  const declared = readDeclaredDtype(model, cacheRoot);
  if (declared.kind === "string") return declared.value;
  // Per-file object maps: do not pass options.dtype — it would override config.
  if (declared.kind === "object") return undefined;
  return detectCachedDtype(model, cacheRoot);
}

export type EmbeddingTask = "document" | "query";

export type EmbedOptions = {
  task?: EmbeddingTask;
};

const NOMIC_TASK_PREFIXES: Record<EmbeddingTask, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

export type EmbeddingTaskPrefixOptions = {
  useTaskPrefixes?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
};

/**
 * Resolve the prefix for a task: explicit/custom → Nomic (when enabled) → none.
 * Empty string means "no prefix" (disables Nomic fallback for that task).
 */
export function resolveEmbeddingTaskPrefix(
  task: EmbeddingTask,
  options: EmbeddingTaskPrefixOptions = {}
): string {
  const custom = task === "query" ? options.queryPrefix : options.documentPrefix;
  if (custom !== undefined) return custom;
  if (options.useTaskPrefixes) return NOMIC_TASK_PREFIXES[task];
  return "";
}

/**
 * Apply task prefixes when configured.
 * Cache keys and API/local inputs should use the returned string.
 *
 * Third argument accepts the legacy boolean (`useTaskPrefixes`) or an options
 * object. Defaults read from CONFIG (custom/preset prefixes + Nomic flag).
 */
export function applyEmbeddingTaskPrefix(
  text: string,
  options?: EmbedOptions,
  useTaskPrefixesOrOpts: boolean | EmbeddingTaskPrefixOptions = {
    useTaskPrefixes: CONFIG.embeddingUseTaskPrefixes,
    queryPrefix: CONFIG.embeddingQueryPrefix,
    documentPrefix: CONFIG.embeddingDocumentPrefix,
  }
): string {
  if (!options?.task) return text;

  const prefixOpts: EmbeddingTaskPrefixOptions =
    typeof useTaskPrefixesOrOpts === "boolean"
      ? {
          useTaskPrefixes: useTaskPrefixesOrOpts,
          queryPrefix: CONFIG.embeddingQueryPrefix,
          documentPrefix: CONFIG.embeddingDocumentPrefix,
        }
      : {
          useTaskPrefixes: useTaskPrefixesOrOpts.useTaskPrefixes ?? CONFIG.embeddingUseTaskPrefixes,
          queryPrefix: useTaskPrefixesOrOpts.queryPrefix ?? CONFIG.embeddingQueryPrefix,
          documentPrefix: useTaskPrefixesOrOpts.documentPrefix ?? CONFIG.embeddingDocumentPrefix,
        };

  const prefix = resolveEmbeddingTaskPrefix(options.task, prefixOpts);
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}

export function embeddingCacheFingerprint(): string {
  return [
    CONFIG.embeddingModel,
    CONFIG.embeddingPooling,
    CONFIG.embeddingQueryPrefix ?? "",
    CONFIG.embeddingDocumentPrefix ?? "",
    CONFIG.embeddingUseTaskPrefixes ? "1" : "0",
    CONFIG.embeddingDtype ?? "",
    // Endpoint identity: a changed URL (or a remote/local switch) must
    // invalidate cached vectors and reinitialize the backend (hot reload).
    // Otherwise vectors from the previous endpoint would keep being served.
    CONFIG.embeddingApiUrl ?? "",
    CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey ? "remote" : "local",
  ].join("\0");
}

type HfTransformers = typeof import("@huggingface/transformers");

let _transformers: {
  pipeline: HfTransformers["pipeline"];
  env: HfTransformers["env"];
} | null = null;

function getTransformersPackageSpecifier(): string {
  // Keep this non-literal so OpenCode/Bun plugin-loader bundling does not eagerly
  // traverse @huggingface/transformers internals during plugin startup. The package
  // is only needed for the local embedding backend, and should stay lazy.
  return ["@huggingface", "transformers"].join("/");
}

async function ensureTransformersLoaded(): Promise<NonNullable<typeof _transformers>> {
  if (_transformers !== null) return _transformers;
  // Pin onnxruntime-node (+ common) to our direct 1.30.0 stack before transformers
  // resolves them (#184 / #210 / #225). Load the CJS export so Module._resolveFilename
  // shim applies — the ESM entry's static import bypasses it under OpenCode nested installs.
  //
  // Critical ordering for OpenCode's Bun --compile host (#210 follow-up):
  // resolve the transformers absolute path BEFORE installOnnxruntimeResolveShim().
  // After the shim is installed, non-onnx Module._resolveFilename fallbacks fail with
  // `Cannot find module '@huggingface/transformers' from ''` even though the package
  // exists. Loading via the pre-resolved absolute path keeps the onnx pin shim active
  // for transformers' nested requires without needing a post-shim package resolve.
  const transformersSpecifier = getTransformersPackageSpecifier();
  let transformersEntry: string;
  try {
    transformersEntry = requireFromHere.resolve(transformersSpecifier);
  } catch (error) {
    throw new Error(
      `Cannot resolve ${transformersSpecifier} before installing the onnxruntime pin shim. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  prepareOnnxruntimeForTransformers();
  const mod = requireFromHere(transformersEntry) as HfTransformers;
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = true;
  mod.env.cacheDir = join(CONFIG.storagePath, ".cache");
  // Keep ONNX WASM single-threaded for Bun/Node runtimes without SharedArrayBuffer.
  try {
    (mod.env as any).backends.onnx.wasm.numThreads = 1;
  } catch (e) {
    log("Failed to set wasm.numThreads", { error: String(e) });
  }
  _transformers = mod;
  return _transformers!;
}

/**
 * Production transformers load path used by nested OpenCode install fixtures (#210).
 * Prefer this over a separately anchored createRequire() so empty-referrer hosts are covered.
 */
export async function loadLocalTransformersBackend(): Promise<NonNullable<typeof _transformers>> {
  return ensureTransformersLoaded();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * A remote embedding endpoint is configured but unusable (API key missing or
 * unresolvable). Thrown instead of silently falling back to the local CPU
 * ONNX path, which would saturate the machine without telling the user.
 */
export class EmbeddingMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingMisconfiguredError";
  }
}

/**
 * True when a remote endpoint is configured but its key is missing, so the
 * local CPU path must not be taken. Checks live config first (robust against
 * a stale status) and `CONFIG.embeddingStatus` second — never guess.
 */
export function isEmbeddingMisconfigured(): boolean {
  if (CONFIG.embeddingApiUrl && !CONFIG.embeddingApiKey) return true;
  return CONFIG.embeddingStatus?.mode === "misconfigured";
}

function buildMisconfiguredEmbeddingError(): EmbeddingMisconfiguredError {
  const statusIssue = CONFIG.embeddingStatus?.issues?.[0];
  const cause = statusIssue ?? "embeddingApiKey is not configured or could not be resolved";
  return new EmbeddingMisconfiguredError(
    `Remote embedding endpoint is configured (embeddingApiUrl="${CONFIG.embeddingApiUrl}") ` +
      `but it cannot be used: ${cause}. ` +
      `Refusing to fall back to local CPU embeddings. ` +
      `Fix embeddingApiKey (literal value, env://VAR, or file://path) ` +
      `or unset embeddingApiUrl to select local CPU embeddings explicitly.`
  );
}

/** Throw when the local-CPU fallback must be refused. Checked before any backend work. */
export function throwIfEmbeddingMisconfigured(): void {
  if (isEmbeddingMisconfigured()) throw buildMisconfiguredEmbeddingError();
}

/** Remote embedding call failed with an HTTP status. */
export class EmbeddingHttpError extends Error {
  constructor(
    public readonly status: number,
    statusText: string
  ) {
    super(`API embedding failed: ${status} ${statusText}`);
    this.name = "EmbeddingHttpError";
  }
}

/**
 * Classify an embedding fetch failure as retryable. Only transient conditions
 * are retried: HTTP 429/5xx, per-attempt AbortSignal timeouts, and network
 * TypeErrors from fetch. JSON parse errors, other 4xx, and unexpected errors
 * fail fast so programming/shape bugs are not amplified across attempts.
 */
function isRetryableEmbeddingError(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  // fetch network failures surface as TypeError; AbortSignal.timeout may too
  // depending on runtime (Bun/Node) — accept TimeoutError/AbortError names.
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    if (error instanceof TypeError) return true;
  }
  return false;
}

/**
 * Perform a remote embedding request with bounded retries. Each attempt uses
 * AbortSignal.timeout so a hung connection is cancelled (not orphaned via
 * Promise.race); transient failures (network, abort/timeout, 429, 5xx) are
 * retried with linear backoff, everything else fails fast.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function fetchRemoteEmbeddingWithRetry(
  fetchImpl: FetchLike,
  input: string,
  options: {
    url?: string;
    apiKey?: string;
    model?: string;
    attemptTimeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: number;
  } = {}
): Promise<any> {
  const url = options.url ?? CONFIG.embeddingApiUrl;
  const apiKey = options.apiKey ?? CONFIG.embeddingApiKey;
  const model = options.model ?? CONFIG.embeddingModel;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? REMOTE_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? REMOTE_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? REMOTE_RETRY_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(`${url}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input, model }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (!response.ok) {
        throw new EmbeddingHttpError(response.status, response.statusText);
      }
      try {
        return await response.json();
      } catch (parseError) {
        throw new Error("Invalid embedding API JSON", { cause: parseError });
      }
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableEmbeddingError(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * The subset of `fetch` the embedding path needs. Bun's `typeof fetch` also
 * declares `preconnect`, which a test double need not provide.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class EmbeddingService {
  /**
   * Injectable fetch. Defaults to the global, but tests pass their own so a
   * concurrently running instance (the plugin warms up in the background)
   * cannot interleave requests into the same stub.
   */
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => (globalThis.fetch as FetchLike)(input, init));
  }

  private pipe: any = null;
  private initPromise: Promise<void> | null = null;
  public isWarmedUp: boolean = false;
  /**
   * Last warmup failure message, surfaced via getEmbeddingInitError()/status.
   * Sticky for local (#184 "initializing forever") and misconfigured
   * failures; remote probe failures are retried after a bounded cooldown
   * instead of killing the plugin permanently — see initErrorKind.
   */
  public initError: string | null = null;
  /** Which backend failed; decides whether initError is permanent or retryable. */
  private initErrorKind: "remote" | "local" | "misconfigured" | null = null;
  private cache: Map<string, Float32Array> = new Map();
  private cachedFingerprint: string | null = null;
  /** Fingerprint the live backend (loaded pipe or successful probe) was built for. */
  private activeFingerprint: string | null = null;
  /** Fingerprint current when warmup last failed; a config change clears initError. */
  private failedFingerprint: string | null = null;
  /** Consecutive remote probe failures; reset on success or config change. */
  private remoteFailureCount = 0;
  /** Earliest timestamp for the next remote probe after a failure. */
  private nextRemoteRetryAt = 0;

  static getInstance(): EmbeddingService {
    if (!(globalThis as any)[GLOBAL_EMBEDDING_KEY]) {
      (globalThis as any)[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
    }
    return (globalThis as any)[GLOBAL_EMBEDDING_KEY];
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    this.resetIfConfigChanged();
    if (this.isWarmedUp) return;
    if (this.initError && !this.remoteRetryDue()) {
      // Rebuild the typed refusal so every sticky rethrow stays identifiable.
      if (this.initErrorKind === "misconfigured") throwIfEmbeddingMisconfigured();
      throw new Error(this.initError);
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeModel(progressCallback);
    return this.initPromise;
  }

  /**
   * Hot-reload hook: drop cached vectors and stale backend state when the
   * effective embedding configuration changed. Runs automatically at the top
   * of warmup() and embed() so no external trigger is needed; returns true
   * when state was reset.
   */
  private resetIfConfigChanged(): boolean {
    const fingerprint = embeddingCacheFingerprint();
    let reset = false;
    if (this.cachedFingerprint !== fingerprint) {
      this.clearCache();
      this.cachedFingerprint = fingerprint;
      reset = true;
    }
    if (this.activeFingerprint !== null && this.activeFingerprint !== fingerprint) {
      // The live backend (loaded CPU model or successful remote probe)
      // belongs to a different config: drop the stale pipe, forget warmup,
      // and lift any failure state so the new config gets a clean attempt.
      // Dropping the reference is sufficient — transformers.js holds no other
      // native resources the plugin can release explicitly.
      this.pipe = null;
      this.isWarmedUp = false;
      this.initPromise = null;
      this.initError = null;
      this.initErrorKind = null;
      this.failedFingerprint = null;
      this.remoteFailureCount = 0;
      this.nextRemoteRetryAt = 0;
      this.activeFingerprint = null;
      // Never log secrets: URL and model name only, no key material.
      log("Embedding configuration changed; embedding backend will reinitialize", {
        model: CONFIG.embeddingModel,
        remote: Boolean(CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey),
      });
      reset = true;
    } else if (
      this.initError !== null &&
      this.failedFingerprint !== null &&
      this.failedFingerprint !== fingerprint
    ) {
      // Warmup previously failed and the config has since changed — the fix
      // may be in the new config, so the error must not stay sticky.
      this.initError = null;
      this.initErrorKind = null;
      this.initPromise = null;
      this.failedFingerprint = null;
      this.remoteFailureCount = 0;
      this.nextRemoteRetryAt = 0;
      reset = true;
    }
    return reset;
  }

  /**
   * Public re-evaluation entry point for hot reload (e.g. the config watcher):
   * reset backend state when the embedding configuration changed. Returns
   * true when a reset happened.
   */
  reconfigure(): boolean {
    return this.resetIfConfigChanged();
  }

  /** A failed remote probe may be retried once its bounded cooldown elapsed. */
  private remoteRetryDue(): boolean {
    return this.initErrorKind === "remote" && Date.now() >= this.nextRemoteRetryAt;
  }

  private async initializeModel(progressCallback?: (progress: any) => void): Promise<void> {
    const fingerprint = embeddingCacheFingerprint();
    const misconfigured = isEmbeddingMisconfigured();
    const useRemote = !misconfigured && Boolean(CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey);
    try {
      // Refuse loudly before any backend work: a configured-but-unusable
      // remote endpoint must never silently degrade to local CPU embeddings.
      if (misconfigured) throw buildMisconfiguredEmbeddingError();

      if (useRemote) {
        // Send a probe request to verify the API endpoint is actually reachable.
        // Uses a minimal embedding of "ping" to test the full request pipeline.
        // Retried on transient failure (#400): a single hung probe previously
        // burned the whole 30s budget and set the sticky initError.
        await fetchRemoteEmbeddingWithRetry(this.fetchImpl, "ping");
        this.isWarmedUp = true;
        this.activeFingerprint = fingerprint;
        this.initError = null;
        this.initErrorKind = null;
        this.failedFingerprint = null;
        this.remoteFailureCount = 0;
        this.nextRemoteRetryAt = 0;
        log("Embedding backend ready: remote GPU service", {
          url: CONFIG.embeddingApiUrl,
          model: CONFIG.embeddingModel,
        });
        return;
      }

      // Local model path
      const { pipeline } = await ensureTransformersLoaded();
      // Explicit config wins; otherwise auto-resolve from model declaration / cache (#393).
      const dtype = CONFIG.embeddingDtype ?? resolveLocalOnnxDtype(CONFIG.embeddingModel);
      if (dtype) {
        log("Resolved local ONNX dtype for embedding warmup", {
          model: CONFIG.embeddingModel,
          dtype,
          source: CONFIG.embeddingDtype ? "config" : "auto",
        });
      }
      this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, {
        ...(dtype ? { dtype } : {}),
        progress_callback: progressCallback,
      });
      this.isWarmedUp = true;
      this.activeFingerprint = fingerprint;
      this.initError = null;
      this.initErrorKind = null;
      this.failedFingerprint = null;
      this.remoteFailureCount = 0;
      this.nextRemoteRetryAt = 0;
      log("Embedding model warmed up", {
        model: CONFIG.embeddingModel,
        pooling: CONFIG.embeddingPooling,
        dtype: dtype ?? null,
      });
      log("Embedding backend ready: local CPU ONNX model", {
        model: CONFIG.embeddingModel,
        pooling: CONFIG.embeddingPooling,
        dtype: dtype ?? null,
      });
    } catch (error) {
      const rewritten = formatOnnxruntimeInitError(error);
      this.initPromise = null;
      this.initError = rewritten.message;
      this.failedFingerprint = fingerprint;
      if (misconfigured || rewritten instanceof EmbeddingMisconfiguredError) {
        // Config problem, not a transient failure: stay loud until the config changes.
        this.initErrorKind = "misconfigured";
      } else if (useRemote) {
        // Transient remote outage: retryable after a bounded, linearly
        // increasing cooldown — never a tight loop, never permanent death.
        this.initErrorKind = "remote";
        this.remoteFailureCount += 1;
        this.nextRemoteRetryAt =
          Date.now() +
          Math.min(
            REMOTE_WARMUP_RETRY_BASE_MS * this.remoteFailureCount,
            REMOTE_WARMUP_RETRY_MAX_MS
          );
      } else {
        // Genuinely broken local install: keep the permanent guard (#184).
        this.initErrorKind = "local";
      }
      log("Failed to initialize embedding model", { error: rewritten.message });
      throw rewritten;
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<Float32Array> {
    this.resetIfConfigChanged();
    // Hard guard: no code path may reach the CPU model while a remote
    // endpoint is configured but unusable.
    throwIfEmbeddingMisconfigured();

    const input = applyEmbeddingTaskPrefix(text, options);

    const cached = this.cache.get(input);
    if (cached) return cached;

    if (!this.isWarmedUp && !this.initPromise) {
      await this.warmup();
    }
    if (this.initPromise) {
      await this.initPromise;
    }
    // Config may have changed while warmup was in flight; re-check the refusal.
    throwIfEmbeddingMisconfigured();

    let result: Float32Array;

    if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
      const data: any = await fetchRemoteEmbeddingWithRetry(this.fetchImpl, input);
      result = new Float32Array(data.data[0].embedding);
    } else {
      if (!this.pipe) {
        throw new Error(
          "Local embedding model is not loaded (warmup did not complete); refusing to continue"
        );
      }
      const output = await this.pipe(input, {
        pooling: CONFIG.embeddingPooling,
        normalize: true,
      });
      result = new Float32Array(output.data);
    }

    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(input, result);

    return result;
  }

  async embedWithTimeout(text: string, options?: EmbedOptions): Promise<Float32Array> {
    return withTimeout(this.embed(text, options), TIMEOUT_MS);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();

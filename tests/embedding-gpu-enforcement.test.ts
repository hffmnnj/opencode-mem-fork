import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../src/config.js";
import {
  EmbeddingService,
  EmbeddingMisconfiguredError,
  embeddingCacheFingerprint,
  isEmbeddingMisconfigured,
} from "../src/services/embedding.js";

type SavedEmbeddingConfig = {
  url: string | undefined;
  key: string | undefined;
  status: typeof CONFIG.embeddingStatus;
};

let saved: SavedEmbeddingConfig;
let originalFetch: typeof fetch;
let originalLogFile: string | undefined;

function setEmbeddingConfig(url: string | undefined, key: string | undefined): void {
  (CONFIG as { embeddingApiUrl?: string }).embeddingApiUrl = url;
  (CONFIG as { embeddingApiKey?: string }).embeddingApiKey = key;
  (CONFIG as { embeddingStatus?: unknown }).embeddingStatus = !url
    ? { ready: true, mode: "local", issues: [] }
    : key
      ? { ready: true, mode: "remote", issues: [] }
      : {
          ready: false,
          mode: "misconfigured",
          issues: ["embeddingApiKey is configured but could not be resolved (test)"],
        };
}

type SeenCall = { url: string; auth: string | undefined; body: any };

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>): {
  calls: SeenCall[];
  impl: typeof fetch;
} {
  const calls: SeenCall[] = [];
  const impl = (async (url: unknown, init?: any) => {
    let body: any;
    try {
      body = JSON.parse(String(init?.body ?? "null"));
    } catch {
      body = null;
    }
    calls.push({ url: String(url), auth: init?.headers?.["Authorization"], body });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  // Not installed on globalThis: the plugin warms up in the background, and
  // a global stub would collect those unrelated probes as well.
  return { calls, impl };
}

function embeddingResponse(vector: number[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data: [{ embedding: vector }] }),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  saved = {
    url: CONFIG.embeddingApiUrl,
    key: CONFIG.embeddingApiKey,
    status: CONFIG.embeddingStatus,
  };
  originalFetch = globalThis.fetch;
  originalLogFile = process.env.OPENCODE_MEM_LOG_FILE;
});

afterEach(() => {
  setEmbeddingConfig(saved.url, saved.key);
  (CONFIG as { embeddingStatus?: unknown }).embeddingStatus = saved.status;
  globalThis.fetch = originalFetch;
  if (originalLogFile === undefined) delete process.env.OPENCODE_MEM_LOG_FILE;
  else process.env.OPENCODE_MEM_LOG_FILE = originalLogFile;
});

describe("misconfigured remote endpoint (url set, key unresolvable)", () => {
  it("refuses the local CPU fallback with a descriptive error and never loads a pipeline", async () => {
    const url = "https://gpu-embeddings.example.invalid/v1";
    setEmbeddingConfig(url, undefined);
    expect(isEmbeddingMisconfigured()).toBe(true);

    const { calls, impl } = stubFetch(async () => embeddingResponse([0.1, 0.2]));
    const service = new EmbeddingService(impl);

    const error = await service.warmup().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(EmbeddingMisconfiguredError);
    const message = String((error as Error)?.message ?? error);
    // Actionable: names the configured URL, the missing key, the refusal, and the fix.
    expect(message).toContain(url);
    expect(message).toContain("embeddingApiKey");
    expect(message).toMatch(/refus/i);
    expect(message).toMatch(/local CPU/i);
    expect(message).toMatch(/env:\/\/VAR|file:\/\/path/);

    // No remote probe was attempted and no local pipeline was loaded.
    expect(calls.length).toBe(0);
    expect((service as any).pipe).toBeNull();
    expect(service.isWarmedUp).toBe(false);
    expect(service.initError).toContain("Refusing to fall back to local CPU");

    // Sticky: a second warmup fails the same way without touching any backend.
    await expect(service.warmup()).rejects.toBeInstanceOf(EmbeddingMisconfiguredError);
    expect(calls.length).toBe(0);
    expect((service as any).pipe).toBeNull();
  });

  it("embed() refuses even with a planted pipe, so no path can reach the CPU model", async () => {
    setEmbeddingConfig("https://gpu-embeddings.example.invalid/v1", undefined);
    const { impl } = stubFetch(async () => embeddingResponse([0.1, 0.2]));
    const service = new EmbeddingService(impl);
    (service as any).pipe = async () => {
      throw new Error("CPU pipe must not be called while misconfigured");
    };

    await expect(service.embed("hello")).rejects.toBeInstanceOf(EmbeddingMisconfiguredError);
    expect(service.initError).toBeNull();
  });

  it("does not treat a healthy remote config as misconfigured", () => {
    setEmbeddingConfig("https://gpu-embeddings.example.invalid/v1", "secret");
    expect(isEmbeddingMisconfigured()).toBe(false);
    setEmbeddingConfig(undefined, undefined);
    expect(isEmbeddingMisconfigured()).toBe(false);
  });
});

describe("endpoint change invalidates cache and reinitializes", () => {
  it("serves fresh vectors from the new endpoint and re-probes it", async () => {
    const vectors: Record<string, number[]> = {
      "https://a.example.invalid/v1": [1, 0],
      "https://b.example.invalid/v1": [0, 1],
    };
    const { calls, impl } = stubFetch(async (url) => {
      const base = Object.keys(vectors).find((b) => url.startsWith(b));
      if (!base) return errorResponse(404);
      return embeddingResponse(vectors[base]!);
    });

    setEmbeddingConfig("https://a.example.invalid/v1", "key-a");
    const f1 = embeddingCacheFingerprint();
    const service = new EmbeddingService(impl);

    const first = await service.embed("hello");
    expect([...first]).toEqual([1, 0]);
    expect(service.isWarmedUp).toBe(true);

    setEmbeddingConfig("https://b.example.invalid/v1", "key-b");
    const f2 = embeddingCacheFingerprint();
    expect(f2).not.toBe(f1);

    // Explicit reconfigure() also reports the change.
    const fresh = new EmbeddingService(impl);
    setEmbeddingConfig("https://a.example.invalid/v1", "key-a");
    await fresh.embed("hello");
    setEmbeddingConfig("https://b.example.invalid/v1", "key-b");
    expect(fresh.reconfigure()).toBe(true);

    const second = await service.embed("hello");
    // Must be the new endpoint's vector, not the cached vector from endpoint A.
    expect([...second]).toEqual([0, 1]);

    // The probe re-ran against endpoint B, and the embed used the new key.
    const probes = calls.filter(
      (c) => c.url.startsWith("https://b.example.invalid") && c.body?.input === "ping"
    );
    expect(probes.length).toBeGreaterThanOrEqual(1);
    const embeds = calls.filter(
      (c) => c.url.startsWith("https://b.example.invalid") && c.body?.input === "hello"
    );
    expect(embeds.length).toBeGreaterThanOrEqual(1);
    expect(embeds.at(-1)!.auth).toBe("Bearer key-b");
  });
});

describe("remote probe failure is retryable but bounded", () => {
  it("fails fast on immediate retry (no probe storm) and recovers after the cooldown", async () => {
    let down = true;
    const { calls, impl } = stubFetch(async () =>
      down ? errorResponse(503) : embeddingResponse([0.5, 0.5])
    );
    setEmbeddingConfig("https://gpu-embeddings.example.invalid/v1", "key");
    const service = new EmbeddingService(impl);

    // First probe exhausts its bounded retries (3 attempts) and fails.
    await expect(service.warmup()).rejects.toThrow();
    expect(service.isWarmedUp).toBe(false);
    expect(service.initError).not.toBeNull();
    const callsAfterFirst = calls.length;
    expect(callsAfterFirst).toBe(3);

    // Immediate retry fails fast with the cached error — no new probe, no spin.
    await expect(service.warmup()).rejects.toThrow(service.initError!);
    expect(calls.length).toBe(callsAfterFirst);

    // Service recovered and the cooldown elapsed: warmup succeeds (no permanent death).
    down = false;
    (service as any).nextRemoteRetryAt = 0;
    await service.warmup();
    expect(service.isWarmedUp).toBe(true);
    expect(service.initError).toBeNull();

    const vector = await service.embed("hello");
    expect([...vector]).toEqual([0.5, 0.5]);
  });

  it("a config change clears a remote failure so the new config gets a clean attempt", async () => {
    // The handler flips from failing to healthy: the endpoint identity is
    // driven by CONFIG, so only the health changes.
    let healthy = false;
    const { impl } = stubFetch(async () =>
      healthy ? embeddingResponse([0.2, 0.3]) : errorResponse(503)
    );
    setEmbeddingConfig("https://down.example.invalid/v1", "key");
    const service = new EmbeddingService(impl);
    await expect(service.warmup()).rejects.toThrow();
    expect(service.initError).not.toBeNull();

    // Point at a healthy endpoint: the stale error must not block the retry.
    healthy = true;
    setEmbeddingConfig("https://up.example.invalid/v1", "key");
    await service.warmup();
    expect(service.isWarmedUp).toBe(true);
    expect(service.initError).toBeNull();
  });
});

describe("active embedding mode is observable", () => {
  it("logs the remote GPU endpoint URL without key material on warmup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-embed-log-"));
    const logFile = join(dir, "test.log");
    process.env.OPENCODE_MEM_LOG_FILE = logFile;
    try {
      const url = "https://gpu-embeddings.example.invalid/v1";
      const { impl } = stubFetch(async () => embeddingResponse([0.1, 0.2]));
      setEmbeddingConfig(url, "super-secret-key");
      const service = new EmbeddingService(impl);
      await service.warmup();

      const contents = readFileSync(logFile, "utf-8");
      expect(contents).toContain("remote GPU service");
      expect(contents).toContain(url);
      expect(contents).not.toContain("super-secret-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

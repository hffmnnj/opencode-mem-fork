import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox HOME before the config module is first evaluated, mirroring
// tests/config.test.ts, so the module-level mkdir/template write stays local.
const home = mkdtempSync(join(tmpdir(), "opencode-mem-hot-reload-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

// Namespace import (not destructured): initConfig/startConfigWatcher reassign
// the exported CONFIG binding, so tests must read CONFIG live off the module.
const configMod = await import("../src/config.js");
const hotReloadMod = await import("../src/services/config-hot-reload.js");

const TEST_DIR = "/hot-reload/project";

const normalizePath = (p: unknown) => String(p).replace(/\\/g, "/");

type WatchListener = (eventType: string, filename: string | null) => void;

class FakeWatcher extends EventEmitter {
  closed = false;
  override close(): this {
    this.closed = true;
    return this;
  }
}

let existsSpy: ReturnType<typeof spyOn> | undefined;
let readSpy: ReturnType<typeof spyOn> | undefined;
let watchSpy: ReturnType<typeof spyOn> | undefined;
let fileContent = "{}";
const listeners: WatchListener[] = [];
const fakeWatchers: FakeWatcher[] = [];

function mockConfigFiles(content: () => string): void {
  // Global paths carry the fixture; project paths are empty so remote
  // provider fields never trip the project-config safety assertion.
  existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
  readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
    const path = normalizePath(args[0]);
    if (path.includes(".opencode/opencode-mem")) {
      return "{}";
    }
    return content();
  }) as typeof fs.readFileSync);
}

function mockWatcher(): void {
  listeners.length = 0;
  fakeWatchers.length = 0;
  watchSpy = spyOn(fs, "watch").mockImplementation(((...args: unknown[]) => {
    const listener = args[args.length - 1] as WatchListener;
    listeners.push(listener);
    const watcher = new FakeWatcher();
    fakeWatchers.push(watcher);
    return watcher;
  }) as typeof fs.watch);
}

function fireChange(dirIndex: number, filename: string | null): void {
  const listener = listeners[dirIndex];
  expect(listener).toBeDefined();
  listener!("change", filename);
}

async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, hotReloadMod.CONFIG_WATCH_DEBOUNCE_MS + 200));
}

afterEach(() => {
  hotReloadMod.stopConfigHotReload(TEST_DIR);
  watchSpy?.mockRestore();
  readSpy?.mockRestore();
  existsSpy?.mockRestore();
  watchSpy = undefined;
  readSpy = undefined;
  existsSpy = undefined;
  // Reset to defaults with the real (empty sandbox) filesystem.
  configMod.initConfig("/nonexistent-project");
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

describe("config hot reload", () => {
  it("reloads CONFIG when a watched config file changes", async () => {
    fileContent = JSON.stringify({ similarityThreshold: 0.6 });
    mockConfigFiles(() => fileContent);
    mockWatcher();

    configMod.initConfig(TEST_DIR);
    expect(configMod.CONFIG.similarityThreshold).toBe(0.6);

    const stop = hotReloadMod.startConfigHotReload(TEST_DIR);
    // Global dir + project .opencode dir.
    expect(listeners.length).toBe(2);

    fileContent = JSON.stringify({ similarityThreshold: 0.9 });
    fireChange(0, "opencode-mem.jsonc");
    await waitForDebounce();
    expect(configMod.CONFIG.similarityThreshold).toBe(0.9);
    stop();
  });

  it("ignores events for unrelated files in the watched directories", async () => {
    fileContent = JSON.stringify({ similarityThreshold: 0.6 });
    mockConfigFiles(() => fileContent);
    mockWatcher();

    configMod.initConfig(TEST_DIR);
    const stop = hotReloadMod.startConfigHotReload(TEST_DIR);

    fileContent = JSON.stringify({ similarityThreshold: 0.9 });
    fireChange(0, "opencode.json");
    fireChange(1, "notes.txt");
    await waitForDebounce();
    expect(configMod.CONFIG.similarityThreshold).toBe(0.6);
    stop();
  });

  it("does not create duplicate watchers for the same directory", () => {
    mockConfigFiles(() => "{}");
    mockWatcher();

    const first = hotReloadMod.startConfigHotReload(TEST_DIR);
    const callsAfterFirst = watchSpy!.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = hotReloadMod.startConfigHotReload(TEST_DIR);
    expect(watchSpy!.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toBe(first);

    first();
    expect(hotReloadMod.stopConfigHotReload(TEST_DIR)).toBe(false);
    expect(fakeWatchers.every((w) => w.closed)).toBe(true);
  });

  it("keeps watching after a reload failure so the next valid save recovers", async () => {
    fileContent = JSON.stringify({ similarityThreshold: 0.6 });
    mockConfigFiles(() => fileContent);
    mockWatcher();

    configMod.initConfig(TEST_DIR);
    const stop = hotReloadMod.startConfigHotReload(TEST_DIR);

    // Half-written save: unreadable everywhere.
    fileContent = "{not valid json";
    fireChange(0, "opencode-mem.jsonc");
    await waitForDebounce();
    expect(configMod.CONFIG.similarityThreshold).toBe(0.6);
    expect(configMod.lastConfigLoadErrors.length).toBeGreaterThan(0);

    // Next valid save recovers without a restart or re-watch.
    fileContent = JSON.stringify({ similarityThreshold: 0.85 });
    fireChange(0, "opencode-mem.jsonc");
    await waitForDebounce();
    expect(configMod.CONFIG.similarityThreshold).toBe(0.85);
    expect(configMod.lastConfigLoadErrors).toEqual([]);
    stop();
  });

  it("startConfigWatcher never throws when watching is unsupported", () => {
    mockConfigFiles(() => "{}");
    watchSpy = spyOn(fs, "watch").mockImplementation((() => {
      throw new Error("ENOSYS: watching not supported");
    }) as typeof fs.watch);

    let stop: (() => void) | undefined;
    expect(() => {
      stop = hotReloadMod.startConfigHotReload(TEST_DIR);
    }).not.toThrow();
    expect(typeof stop).toBe("function");
    stop!();
  });
});

describe("defensive secret resolution (F3)", () => {
  it("does not throw when an embedding secret is unresolvable; reports misconfigured", () => {
    const key = "OPENCODE_MEM_TEST_UNSET_SECRET_XYZ";
    delete process.env[key];
    const openAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      mockConfigFiles(() =>
        JSON.stringify({
          embeddingApiUrl: "https://embeddings.example.invalid/v1",
          embeddingApiKey: `env://${key}`,
        })
      );

      expect(() => configMod.initConfig(TEST_DIR)).not.toThrow();
      expect(configMod.CONFIG.embeddingApiKey).toBeUndefined();
      // Loud, visible error state instead of a silent local-CPU fallback.
      expect(configMod.CONFIG.embeddingStatus).toEqual({
        ready: false,
        mode: "misconfigured",
        issues: expect.arrayContaining([
          expect.stringContaining("embeddingApiKey is configured but could not be resolved"),
        ]),
      });
      expect(configMod.CONFIG.configIssues).toEqual(
        expect.arrayContaining([expect.stringContaining("embeddingApiKey:")])
      );
    } finally {
      if (openAiKey !== undefined) process.env.OPENAI_API_KEY = openAiKey;
    }
  });

  it("does not throw when the memory secret is unresolvable; key reads as unconfigured", () => {
    const key = "OPENCODE_MEM_TEST_UNSET_MEMORY_XYZ";
    delete process.env[key];
    mockConfigFiles(() =>
      JSON.stringify({
        memoryProvider: "openai-chat",
        memoryModel: "gpt-4o-mini",
        memoryApiUrl: "https://api.openai.com/v1",
        memoryApiKey: `env://${key}`,
      })
    );

    expect(() => configMod.initConfig(TEST_DIR)).not.toThrow();
    expect(configMod.CONFIG.memoryApiKey).toBeUndefined();
    expect(configMod.CONFIG.configIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("memoryApiKey:")])
    );
    expect(configMod.CONFIG.autoCaptureProviderStatus.ready).toBe(false);
  });

  it("reports remote-ready embedding status when the secret resolves", () => {
    const key = "OPENCODE_MEM_TEST_SET_SECRET";
    const old = process.env[key];
    process.env[key] = "resolved-secret";
    try {
      mockConfigFiles(() =>
        JSON.stringify({
          embeddingApiUrl: "https://embeddings.example.invalid/v1",
          embeddingApiKey: `env://${key}`,
        })
      );
      configMod.initConfig(TEST_DIR);
      expect(configMod.CONFIG.embeddingApiKey).toBe("resolved-secret");
      expect(configMod.CONFIG.embeddingStatus).toEqual({ ready: true, mode: "remote", issues: [] });
      expect(configMod.CONFIG.configIssues).toEqual([]);
    } finally {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  });

  it("keeps last-known-good config when a saved file becomes invalid", () => {
    let content = JSON.stringify({ similarityThreshold: 0.75 });
    mockConfigFiles(() => content);

    configMod.initConfig(TEST_DIR);
    expect(configMod.CONFIG.similarityThreshold).toBe(0.75);

    content = "{half-written save";
    expect(() => configMod.initConfig(TEST_DIR)).not.toThrow();
    expect(configMod.CONFIG.similarityThreshold).toBe(0.75);
    expect(configMod.lastConfigLoadErrors.length).toBeGreaterThan(0);

    content = JSON.stringify({ similarityThreshold: 0.8 });
    configMod.initConfig(TEST_DIR);
    expect(configMod.CONFIG.similarityThreshold).toBe(0.8);
  });
});

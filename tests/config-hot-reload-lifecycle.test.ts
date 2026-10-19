/**
 * Fork F4a/F4b — config hot reload wiring.
 *
 * The plugin must react to a config-file change without an OpenCode restart:
 * the watcher is started during plugin setup and stopped on dispose, and a
 * reloaded config is reflected in the exported CONFIG binding.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG, initConfig } from "../src/config.js";
import { startConfigHotReload, stopConfigHotReload } from "../src/services/config-hot-reload.js";

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mem-hot-reload-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("config hot reload", () => {
  it("re-reads the project config and updates CONFIG without a restart", async () => {
    const dir = makeTempDir();
    const projectConfigDir = join(dir, ".opencode");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectConfigDir, { recursive: true });
    const projectFile = join(projectConfigDir, "opencode-mem.jsonc");

    writeFileSync(projectFile, JSON.stringify({ similarityThreshold: 0.42 }));
    initConfig(dir);
    expect(CONFIG.similarityThreshold).toBe(0.42);

    // A save to the same file must be picked up by the watcher.
    const stop = startConfigHotReload(dir);
    try {
      writeFileSync(projectFile, JSON.stringify({ similarityThreshold: 0.77 }));
      const deadline = Date.now() + 5000;
      while (CONFIG.similarityThreshold !== 0.77 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(CONFIG.similarityThreshold).toBe(0.77);
    } finally {
      stop();
    }
  });

  it("stops cleanly and does not reload after stop", async () => {
    const dir = makeTempDir();
    const projectConfigDir = join(dir, ".opencode");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectConfigDir, { recursive: true });
    const projectFile = join(projectConfigDir, "opencode-mem.jsonc");

    writeFileSync(projectFile, JSON.stringify({ similarityThreshold: 0.11 }));
    initConfig(dir);

    const stop = startConfigHotReload(dir);
    stop();
    // Stopping twice must be safe.
    stop();

    writeFileSync(projectFile, JSON.stringify({ similarityThreshold: 0.99 }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(CONFIG.similarityThreshold).toBe(0.11);
  });

  it("does not create duplicate watchers for the same directory", async () => {
    const dir = makeTempDir();
    const first = startConfigHotReload(dir);
    const second = startConfigHotReload(dir);
    // The registry returns the existing stop function for the same directory.
    expect(second).toBe(first);
    first();
    expect(stopConfigHotReload(dir)).toBe(false);
  });

  it("keeps the previous configuration when the file becomes unparsable", async () => {
    const dir = makeTempDir();
    const projectConfigDir = join(dir, ".opencode");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectConfigDir, { recursive: true });
    const projectFile = join(projectConfigDir, "opencode-mem.jsonc");

    writeFileSync(projectFile, JSON.stringify({ similarityThreshold: 0.33 }));
    initConfig(dir);
    expect(CONFIG.similarityThreshold).toBe(0.33);

    const stop = startConfigHotReload(dir);
    try {
      writeFileSync(projectFile, "{ this is not valid json");
      await new Promise((resolve) => setTimeout(resolve, 800));
      // A half-written save must not silently reset the live configuration.
      expect(CONFIG.similarityThreshold).toBe(0.33);

      // The next valid save recovers.
      writeFileSync(projectFile, JSON.stringify({ similarityThreshold: 0.55 }));
      const deadline = Date.now() + 5000;
      while (CONFIG.similarityThreshold !== 0.55 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(CONFIG.similarityThreshold).toBe(0.55);
    } finally {
      stop();
    }
  });
});

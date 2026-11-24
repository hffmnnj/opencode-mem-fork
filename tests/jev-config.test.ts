import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { initConfig, CONFIG } from "../src/config.js";

describe("jev config", () => {
  let readSpy: ReturnType<typeof spyOn>;
  let existsSpy: ReturnType<typeof spyOn>;

  const normalizePath = (p: unknown) => String(p).replace(/\\/g, "/");

  function loadGlobal(globalConfig: unknown) {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p: unknown) =>
      normalizePath(p).includes(".config/opencode/opencode-mem")
    );
    readSpy = spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(globalConfig) as any);
    initConfig("/some/project");
  }

  afterEach(() => {
    readSpy?.mockRestore();
    existsSpy?.mockRestore();
    // Reset to global-only config
    initConfig("/nonexistent-project");
  });

  it("stays disabled with safe limits when unconfigured", () => {
    loadGlobal({});
    expect(CONFIG.jev).toEqual({ enabled: false, timeoutMs: 2500, maxCandidates: 12 });
  });

  it("accepts an explicit opt-in within valid bounds", () => {
    loadGlobal({ jev: { enabled: true, timeoutMs: 5000, maxCandidates: 20 } });
    expect(CONFIG.jev).toEqual({ enabled: true, timeoutMs: 5000, maxCandidates: 20 });

    loadGlobal({ jev: { enabled: true, timeoutMs: 249, maxCandidates: 0 } });
    expect(CONFIG.jev).toEqual({ enabled: true, timeoutMs: 250, maxCandidates: 1 });

    loadGlobal({ jev: { enabled: true, timeoutMs: 99999, maxCandidates: 99 } });
    expect(CONFIG.jev).toEqual({ enabled: true, timeoutMs: 10000, maxCandidates: 24 });
  });

  it("refuses a repository enabling remote Jev without global consent", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p: unknown) =>
      normalizePath(p).endsWith("/some/project/.opencode/opencode-mem.jsonc")
    );
    readSpy = spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ jev: { enabled: true } }) as any
    );
    expect(() => initConfig("/some/project")).toThrow(
      "Project config cannot set remote provider fields: jev"
    );
  });

  it("never enables on malformed values and falls back to safe limits", () => {
    loadGlobal({ jev: { enabled: "true", timeoutMs: "2500", maxCandidates: "12" } });
    expect(CONFIG.jev).toEqual({ enabled: false, timeoutMs: 2500, maxCandidates: 12 });

    loadGlobal({
      jev: { enabled: 1, timeoutMs: Number.NaN, maxCandidates: Number.POSITIVE_INFINITY },
    });
    expect(CONFIG.jev).toEqual({ enabled: false, timeoutMs: 2500, maxCandidates: 12 });
  });

  it("rejects null and array sections instead of silently defaulting", () => {
    expect(() => loadGlobal({ jev: null })).toThrow("Invalid jev config");
    expect(() => loadGlobal({ jev: [] })).toThrow("Invalid jev config");
  });
});

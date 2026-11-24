import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

const apiHandlersUrl = new URL("../src/services/api-handlers.js", import.meta.url).href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/services/turso/connection-manager.js", import.meta.url)
  .href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;

const seededMetadata = {
  source: "auto-capture",
  captureVersion: 2,
  memoryKind: "fact",
  evidence: [{ messageId: "msg_42", role: "assistant", quote: "The queue retries three times." }],
  codeAnchors: [{ path: "src/queue.ts", line: 12, quote: "retries = 3" }],
  observedAt: 1_700_000_000_000,
  sessionID: "ses_original",
};

/**
 * Runs one handler scenario in a fresh Bun process: module mocks and the
 * CONFIG.storagePath override are process-wide, and turso readiness caches
 * globally, so isolating them keeps this file safe inside the full suite.
 * The scenario touches only the disposable database under the temp dir.
 */
function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-update-provenance-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
}));

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array(768),
  },
}));

const baseDir = process.argv[2];
const { CONFIG } = await import(${JSON.stringify(configUrl)});
CONFIG.storagePath = baseDir;
CONFIG.embeddingDimensions = 768;

const { ensureTursoReady } = await import(${JSON.stringify(readyUrl)});
await ensureTursoReady();

const { tursoConnectionManager } = await import(${JSON.stringify(connectionManagerUrl)});
const { tursoShardManager } = await import(${JSON.stringify(shardManagerUrl)});
const { tursoVectorSearch } = await import(${JSON.stringify(vectorSearchUrl)});
const { handleUpdateMemory } = await import(${JSON.stringify(apiHandlersUrl)});

const memoryId = "mem_edit_provenance";
const scopeHash = "0123456789abcdef";
const shard = await tursoShardManager.createShard("project", scopeHash, 0);
const db = await tursoConnectionManager.getConnection(shard.dbPath);

const vector = new Float32Array(768);
vector[0] = 1;
await tursoVectorSearch.insertVector(db, {
  id: memoryId,
  content: "The queue retries three times before failing.",
  vector,
  containerTag: \`opencode_project_\${scopeHash}\`,
  tags: "auth,verification",
  type: "fact",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  metadata: JSON.stringify(${JSON.stringify(seededMetadata)}),
});
await tursoVectorSearch.pinMemory(db, memoryId);

const seededRow = await tursoVectorSearch.getMemoryById(db, memoryId);
const seededStoredMetadata = JSON.parse(String(seededRow?.metadata));
if (
  Number(seededRow?.is_pinned) !== 1 ||
  seededStoredMetadata.evidence?.length !== 1 ||
  seededStoredMetadata.codeAnchors?.length !== 1 ||
  seededStoredMetadata.observedAt !== 1_700_000_000_000
) {
  throw new Error("seed memory did not persist its pin and provenance");
}

async function report(response) {
  const row = await tursoVectorSearch.getMemoryById(db, memoryId);
  console.log(JSON.stringify({
    success: response.success,
    error: response.error ?? null,
    content: row ? String(row.content) : null,
    tags: row?.tags ? String(row.tags).split(",") : [],
    isPinned: row ? Number(row.is_pinned) : null,
    metadata: row?.metadata ? JSON.parse(String(row.metadata)) : null,
  }));
}

${scriptBody}
`;
  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath, dir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{"));

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: jsonLine ? JSON.parse(jsonLine) : null,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("handleUpdateMemory provenance", () => {
  it("content edit clears evidence, code anchors, and observedAt", () => {
    const result = runScenario(`
const response = await handleUpdateMemory(memoryId, {
  content: "The queue retries five times with backoff.",
});
await report(response);
`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parsed?.success).toBe(true);
    expect(result.parsed?.error).toBeNull();
    expect(result.parsed?.content).toBe("The queue retries five times with backoff.");

    const metadata = result.parsed?.metadata ?? {};
    expect(metadata.evidence).toBeUndefined();
    expect(metadata.codeAnchors).toBeUndefined();
    expect(metadata.observedAt).toBeUndefined();
    expect(metadata.source).toBe("manual");
    expect(metadata.previousSource).toBe("auto-capture");
    expect(typeof metadata.editedAt).toBe("number");
    // Unrelated capture facts survive the edit.
    expect(metadata.memoryKind).toBe("fact");
    expect(metadata.captureVersion).toBe(2);
    expect(metadata.sessionID).toBe("ses_original");
  });

  it("content edit keeps the existing pin", () => {
    const result = runScenario(`
const response = await handleUpdateMemory(memoryId, {
  content: "The queue retries five times with backoff.",
});
await report(response);
`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parsed?.success).toBe(true);
    expect(result.parsed?.isPinned).toBe(1);
  });

  it("tags-only update keeps evidence and capture metadata untouched", () => {
    const result = runScenario(`
const response = await handleUpdateMemory(memoryId, {
  tags: ["auth", "edited"],
});
await report(response);
`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parsed?.success).toBe(true);
    expect(result.parsed?.content).toBe("The queue retries three times before failing.");
    expect(result.parsed?.tags).toEqual(["auth", "edited"]);
    expect(result.parsed?.metadata).toEqual(seededMetadata);
  });

  it("tags-only update keeps the existing pin", () => {
    const result = runScenario(`
const response = await handleUpdateMemory(memoryId, {
  tags: ["auth", "edited"],
});
await report(response);
`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parsed?.success).toBe(true);
    expect(result.parsed?.isPinned).toBe(1);
  });
});

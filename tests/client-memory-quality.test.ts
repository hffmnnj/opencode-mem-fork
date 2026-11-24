import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/services/turso/connection-manager.js", import.meta.url)
  .href;
const vectorUtilsUrl = new URL("../src/services/turso/vector-utils.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const jevUrl = new URL("../src/services/jev.js", import.meta.url).href;

const PROJECT_TAG = "opencode_project_abcdef1234567890";

const SEARCH_CANDIDATES = [
  {
    id: "hist-1",
    memory: "old session summary chatter",
    similarity: 0.95,
    scoreComponents: { content: 0.95, tags: 0, keyword: 0 },
    metadata: { source: "auto-capture" },
    containerTag: PROJECT_TAG,
    createdAt: 300,
  },
  {
    id: "hist-2",
    memory: "another old session summary",
    similarity: 0.9,
    scoreComponents: { content: 0.9, tags: 0, keyword: 0 },
    metadata: { source: "auto-capture" },
    containerTag: PROJECT_TAG,
    createdAt: 200,
  },
  {
    id: "dur-1",
    memory: "postgres uses advisory locks for leader election",
    similarity: 0.8,
    scoreComponents: { content: 0.8, tags: 0, keyword: 0 },
    metadata: { source: "auto-capture", captureVersion: 2, memoryKind: "fact" },
    containerTag: PROJECT_TAG,
    createdAt: 100,
  },
];

const SESSION_ROWS = [
  {
    id: "s-hist-1",
    content: "old session chatter",
    tags: [],
    metadata: { source: "auto-capture" },
    container_tag: PROJECT_TAG,
    session_id: "sess-1",
    type: "note",
    created_at: 300,
  },
  {
    id: "s-hist-2",
    content: "more old session chatter",
    tags: [],
    metadata: { source: "auto-capture" },
    container_tag: PROJECT_TAG,
    session_id: "sess-1",
    type: "note",
    created_at: 200,
  },
  {
    id: "s-dur-1",
    content: "postgres uses advisory locks for leader election",
    tags: [],
    metadata: { source: "auto-capture", captureVersion: 2, memoryKind: "fact" },
    container_tag: PROJECT_TAG,
    session_id: "sess-1",
    type: "fact",
    created_at: 100,
  },
];

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-client-quality-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const searchCalls = [];
const jevCalls = [];
const CANDIDATES = ${JSON.stringify(SEARCH_CANDIDATES)};
const SESSION_ROWS = ${JSON.stringify(SESSION_ROWS)};

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array([1, 2, 3]),
  },
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    async getAllShards(scope, hash) {
      return [{ id: 1, scope, scopeHash: hash, shardIndex: 0, dbPath: "/tmp/shard.db" }];
    },
  },
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
    listMemories: async () => [],
    getMemoriesBySessionID: async () => JSON.parse(JSON.stringify(SESSION_ROWS)),
    searchAcrossShards: async (shards, queryVector, containerTag, limit) => {
      searchCalls.push({ limit, containerTag });
      return { results: JSON.parse(JSON.stringify(CANDIDATES)).slice(0, limit), warnings: [] };
    },
  },
}));

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    getConnection: async () => ({}),
    closeAll: async () => {},
  },
}));

mock.module(${JSON.stringify(vectorUtilsUrl)}, () => ({
  formatTagsForEmbedding: (tags) => tags.join(" "),
  parseSessionIdFromMetadata: () => null,
}));

mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: async () => {},
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    maxMemories: 20,
    similarityThreshold: 0.5,
    jev: { enabled: true, timeoutMs: 1000, maxCandidates: 50 },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
}));

mock.module(${JSON.stringify(jevUrl)}, () => ({
  rerankWithJev: async (query, results) => {
    jevCalls.push(results.map((entry) => entry.id));
    return { results, status: "reranked", assessed: results.length, abstained: 0, latencyMs: 1 };
  },
}));

const { memoryClient } = await import(${JSON.stringify(clientUrl)});
${scriptBody}
`;
  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
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

describe("memory client historical versus durable recall", () => {
  it("excluding history keeps a lower durable hit inside the requested count", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemories("locks", ${JSON.stringify(PROJECT_TAG)}, "project", { limit: 1, includeHistorical: false });
console.log(JSON.stringify({
  ids: res.results.map((entry) => entry.id),
  total: res.total,
  searchLimits: searchCalls.map((call) => call.limit),
  jevSeen: jevCalls[0],
  status: res.reranking?.status,
}));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // Bounded-maximum retrieval so lower durable hits survive the filter.
    expect(result.parsed?.searchLimits).toEqual([200]);
    // Jev reranks only the eligible entries for automatic context.
    expect(result.parsed?.jevSeen).toEqual(["dur-1"]);
    // The higher-similarity historical summaries cannot crowd out the durable hit.
    expect(result.parsed?.ids).toEqual(["dur-1"]);
    expect(result.parsed?.total).toBe(1);
    expect(result.parsed?.status).toBe("reranked");
  });

  it("default search keeps history with the existing retrieval limit", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemories("locks", ${JSON.stringify(PROJECT_TAG)}, "project", { limit: 1 });
console.log(JSON.stringify({
  ids: res.results.map((entry) => entry.id),
  searchLimits: searchCalls.map((call) => call.limit),
  jevSeen: jevCalls[0],
}));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.searchLimits).toEqual([1]);
    expect(result.parsed?.jevSeen).toEqual(["hist-1"]);
    expect(result.parsed?.ids).toEqual(["hist-1"]);
  });

  it("session recall filters history before the limit and keeps provenance", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemoriesBySessionID("sess-1", ${JSON.stringify(PROJECT_TAG)}, 1, { includeHistorical: false });
console.log(JSON.stringify({ results: res.results, total: res.total }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // Filtered before the limit: the third-oldest durable row wins over two newer histories.
    expect(result.parsed?.total).toBe(1);
    expect(result.parsed?.results).toHaveLength(1);
    const entry = result.parsed?.results[0];
    expect(entry.id).toBe("s-dur-1");
    expect(entry.retrieval).toBe("session");
    expect(entry.metadata).toEqual({
      source: "auto-capture",
      captureVersion: 2,
      memoryKind: "fact",
    });
    expect(entry.createdAt).toBe(100);
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.type).toBe("fact");
  });

  it("default session recall still returns history", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemoriesBySessionID("sess-1", ${JSON.stringify(PROJECT_TAG)}, 1);
console.log(JSON.stringify({ results: res.results }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.results).toHaveLength(1);
    expect(result.parsed?.results[0].id).toBe("s-hist-1");
    expect(result.parsed?.results[0].retrieval).toBe("session");
  });
});

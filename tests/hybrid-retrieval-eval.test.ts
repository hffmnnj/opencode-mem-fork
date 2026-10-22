import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

// Regression evaluation (not an external benchmark): fixed hybrid retrieval
// versus a clearly described insertion-order list baseline. Expected IDs are
// hardcoded fixtures, never derived from scores produced by the code under test.
describe("hybrid retrieval regression evaluation", () => {
  let baseDir: string | undefined;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
    baseDir = undefined;
  });

  it("eval_fixedRetrievalBeatsListBaselineOnLabeledFixtures", async () => {
    const { CONFIG } = await import("../src/config.js");
    const previousStoragePath = CONFIG.storagePath;
    const previousDims = CONFIG.embeddingDimensions;
    baseDir = mkdtempSync(join(tmpdir(), "turso-hybrid-eval-"));
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 8;

    try {
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

      const scopeHash = "e7f8a9b0c1d23456";
      const containerTag = `opencode_project_${scopeHash}`;
      const shard = await tursoShardManager.createShard("project", scopeHash, 0);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);

      // Identical vectors so ranking is decided by lexical/tag coverage.
      const vec = new Float32Array(8);
      vec[0] = 1;
      const now = 1700000000000;
      const fixtures = [
        {
          id: "eval_target_full",
          content: "alpha beta gamma complete match",
          createdAt: now - 1000,
        },
        { id: "eval_filler_1", content: "alpha filler one", createdAt: now - 800 },
        { id: "eval_filler_2", content: "alpha filler two", createdAt: now - 600 },
        {
          id: "eval_code",
          content: "see src/services/turso/vector-search.ts for ranking",
          createdAt: now - 400,
        },
        {
          id: "eval_user_exact",
          content: "user profile settings",
          createdAt: now - 200,
        },
        {
          id: "eval_user_substring",
          content: "superuser account indexing",
          createdAt: now - 100,
        },
      ];
      for (const fixture of fixtures) {
        await tursoVectorSearch.insertVector(db, {
          id: fixture.id,
          content: fixture.content,
          vector: vec,
          containerTag,
          createdAt: fixture.createdAt,
          updatedAt: now,
        });
      }

      const cases: Array<{ query: string; expectedId: string }> = [
        { query: "alpha beta gamma", expectedId: "eval_target_full" },
        {
          query: "src/services/turso/vector-search.ts",
          expectedId: "eval_code",
        },
        { query: "user", expectedId: "eval_user_exact" },
      ];
      const limit = 2;

      // List baseline: newest-first insertion order with no ranking, mimics a
      // plain listMemories ORDER BY created_at DESC LIMIT slice.
      const listed = await tursoVectorSearch.listMemories(db, containerTag, limit);
      const listIds = listed.map((row) => String((row as Record<string, unknown>).id));

      let fixedHits = 0;
      let baselineHits = 0;
      for (const { query, expectedId } of cases) {
        const results = await tursoVectorSearch.searchInShard(
          shard,
          vec,
          containerTag,
          limit,
          query
        );
        const ids = results.map((r) => r.id);
        if (ids.includes(expectedId)) fixedHits += 1;
        if (listIds.includes(expectedId)) baselineHits += 1;
        // Hardcoded expectation: the full-term and exact-boundary documents win.
        expect(ids[0]).toBe(expectedId);
      }

      // The oldest full-match fixture is outside the newest-first list slice,
      // so the ranked fix must beat the list baseline here by construction.
      expect(fixedHits).toBe(cases.length);
      expect(baselineHits).toBe(1);
    } finally {
      CONFIG.storagePath = previousStoragePath;
      CONFIG.embeddingDimensions = previousDims;
    }
  });
});

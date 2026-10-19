import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";
import { Database } from "bun:sqlite";

const SCOPE_HASH = "2233445566778899";

describe("turso legacy migrator dimension preflight", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("preserves legacy dimensions so startup can expose the re-embed migration", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-dim-preflight-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const scopeHash = "0011223344556677";
    const dbPath = join(projectsDir, `project_${scopeHash}_shard_0.db`);
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          vector BLOB NOT NULL,
          container_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);

    const wrongDims = new Float32Array(4);
    wrongDims[0] = 1;
    const insertWrongDims = db.prepare(
      `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertWrongDims.run(
      "mem_wrong_dims",
      "wrong dims",
      new Uint8Array(wrongDims.buffer),
      "opencode_project_dimpreflight",
      Date.now(),
      Date.now()
    );
    insertWrongDims.finalize();
    db.close();

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.legacy.bak`)).toBe(true);
    expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(true);

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const migratedDb = await tursoConnectionManager.getConnection(dbPath);
    const dimensions = await migratedDb.get(
      `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
    );
    expect(Number(dimensions?.value)).toBe(4);

    const count = await migratedDb.get(`SELECT COUNT(*) AS count FROM memories`);
    expect(Number(count?.count)).toBe(1);

    const { migrationService } = await import("../src/services/migration-service.js");
    const mismatch = await migrationService.detectDimensionMismatch();
    expect(mismatch.needsMigration).toBe(true);
    expect(mismatch.shardMismatches).toHaveLength(1);
    expect(mismatch.shardMismatches[0]?.storedDimensions).toBe(4);
  }, 15000);

  it("flags a model swap when dimensions are unchanged", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-model-preflight-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 2;
    CONFIG.embeddingModel = "Xenova/nomic-embed-text-v1";
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const shard = await tursoShardManager.createShard("project", SCOPE_HASH, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoVectorSearch.insertVector(db, {
      id: "mem_model_swap",
      content: "same dims, different model",
      vector: new Float32Array([1, 0]),
      containerTag: `opencode_project_${SCOPE_HASH}`,
      createdAt: 100,
      updatedAt: 200,
    });
    await tursoShardManager.incrementVectorCount(shard.id);

    // Production scenario: every model in use is 768-dimensional, so only the
    // model id changes here while the dimension count stays the same.
    CONFIG.embeddingModel = "onnx-community/embeddinggemma-2-ONNX";

    const { migrationService } = await import("../src/services/migration-service.js");
    const mismatch = await migrationService.detectDimensionMismatch();
    expect(mismatch.needsMigration).toBe(true);
    expect(mismatch.shardMismatches).toHaveLength(1);
    expect(mismatch.shardMismatches[0]?.storedModel).toBe("Xenova/nomic-embed-text-v1");
    expect(mismatch.shardMismatches[0]?.storedDimensions).toBe(2);
  }, 15000);

  it("surfaces unlabelled shards holding vectors but skips empty unlabelled shards", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-unknown-model-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 2;
    CONFIG.embeddingModel = "Xenova/nomic-embed-text-v1";
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const withVectors = await tursoShardManager.createShard("project", SCOPE_HASH, 0);
    const empty = await tursoShardManager.createShard("project", SCOPE_HASH, 1);
    const dbWithVectors = await tursoConnectionManager.getConnection(withVectors.dbPath);
    await tursoVectorSearch.insertVector(dbWithVectors, {
      id: "mem_unlabelled",
      content: "vectors but no model label",
      vector: new Float32Array([1, 0]),
      containerTag: `opencode_project_${SCOPE_HASH}`,
      createdAt: 100,
      updatedAt: 200,
    });
    await tursoShardManager.incrementVectorCount(withVectors.id);

    // Simulate shards that predate embedding_model labelling.
    await dbWithVectors.execute(`DELETE FROM shard_metadata WHERE key = 'embedding_model'`, []);
    const dbEmpty = await tursoConnectionManager.getConnection(empty.dbPath);
    await dbEmpty.execute(`DELETE FROM shard_metadata WHERE key = 'embedding_model'`, []);

    const { migrationService } = await import("../src/services/migration-service.js");
    const mismatch = await migrationService.detectDimensionMismatch();
    expect(mismatch.needsMigration).toBe(true);
    expect(mismatch.shardMismatches).toHaveLength(1);
    expect(mismatch.shardMismatches[0]?.shardId).toBe(withVectors.id);
    expect(mismatch.shardMismatches[0]?.storedModel).toBe("unknown");
  }, 15000);
});

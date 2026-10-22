import { tursoConnectionManager } from "./connection-manager.js";
import { tursoShardManager } from "./shard-manager.js";
import { log } from "../logger.js";
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";
import {
  computeLexicalCoverage,
  computeTagBoost,
  distanceToSimilarity,
  parseSessionIdFromMetadata,
  tokenizeQueryText,
  vectorToJson,
} from "./vector-utils.js";
import type { TursoDb, TursoTx } from "./turso-db.js";

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resolveSessionId(record: MemoryRecord): string | null {
  if (record.sessionId && record.sessionId.length > 0) return record.sessionId;
  return parseSessionIdFromMetadata(record.metadata);
}

function insertArgs(record: MemoryRecord, contentVector: string, tagsVectorJson: string | null) {
  return [
    record.id,
    record.content,
    contentVector,
    ...(tagsVectorJson ? [tagsVectorJson] : []),
    record.containerTag,
    record.tags || null,
    record.type || null,
    record.createdAt,
    record.updatedAt,
    record.metadata || null,
    resolveSessionId(record),
    record.displayName || null,
    record.userName || null,
    record.userEmail || null,
    record.projectPath || null,
    record.projectName || null,
    record.gitRepoUrl || null,
  ];
}

const INSERT_WITH_TAGS = `
  INSERT INTO memories (
    id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
    metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
  ) VALUES (?, ?, vector32(?), vector32(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_WITHOUT_TAGS = `
  INSERT INTO memories (
    id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
    metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
  ) VALUES (?, ?, vector32(?), NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class TursoVectorSearch {
  private async prepareShardDb(db: TursoDb): Promise<void> {
    await tursoShardManager.ensureShardSchema(db);
  }

  async insertVectorInTransaction(tx: TursoTx, record: MemoryRecord): Promise<void> {
    const contentVector = vectorToJson(record.vector);
    if (record.tagsVector) {
      await tx.execute({
        sql: INSERT_WITH_TAGS,
        args: insertArgs(record, contentVector, vectorToJson(record.tagsVector)),
      });
      return;
    }

    await tx.execute({
      sql: INSERT_WITHOUT_TAGS,
      args: insertArgs(record, contentVector, null),
    });
  }

  async insertVector(db: TursoDb, record: MemoryRecord): Promise<void> {
    await this.prepareShardDb(db);
    const contentVector = vectorToJson(record.vector);
    if (record.tagsVector) {
      await db.execute(
        INSERT_WITH_TAGS,
        insertArgs(record, contentVector, vectorToJson(record.tagsVector))
      );
      return;
    }

    await db.execute(INSERT_WITHOUT_TAGS, insertArgs(record, contentVector, null));
  }

  async searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await this.prepareShardDb(db);
    const queryJson = vectorToJson(queryVector);
    // Exact cosine already returns the best-k rows; over-fetch a little so
    // content+tags+keyword candidates can merge before hybrid re-rank.
    const k = Math.max(limit * 2, 32);

    const contentResults = await this.exactScanKind(db, queryJson, k, containerTag, "vector");
    const tagsResults = await this.exactScanKind(db, queryJson, k, containerTag, "tags_vector");
    const keywordScores = await this.keywordScores(db, queryText, containerTag, k);

    const candidateIds = new Set<string>();
    for (const result of contentResults) candidateIds.add(result.id);
    for (const result of tagsResults) candidateIds.add(result.id);
    for (const id of keywordScores.keys()) candidateIds.add(id);

    const ids = Array.from(candidateIds);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.all(
      containerTag === ""
        ? `
      SELECT id, content, tags, created_at, metadata, container_tag,
             display_name, user_name, user_email, project_path, project_name,
             git_repo_url, is_pinned, session_id,
             vector_distance_cos(vector, vector32(?)) AS content_dist,
             CASE WHEN tags_vector IS NOT NULL
               THEN vector_distance_cos(tags_vector, vector32(?))
               ELSE NULL END AS tags_dist
      FROM memories
      WHERE id IN (${placeholders})
    `
        : `
      SELECT id, content, tags, created_at, metadata, container_tag,
             display_name, user_name, user_email, project_path, project_name,
             git_repo_url, is_pinned, session_id,
             vector_distance_cos(vector, vector32(?)) AS content_dist,
             CASE WHEN tags_vector IS NOT NULL
               THEN vector_distance_cos(tags_vector, vector32(?))
               ELSE NULL END AS tags_dist
      FROM memories
      WHERE id IN (${placeholders}) AND container_tag = ?
    `,
      containerTag === ""
        ? [queryJson, queryJson, ...ids]
        : [queryJson, queryJson, ...ids, containerTag]
    );

    const queryWords = tokenizeQueryText(queryText);
    const hasKeyword = queryWords.length > 0;

    const hydratedResults = rows.map((row: Record<string, unknown>) => {
      const contentSim = distanceToSimilarity(Number(row.content_dist));
      const tagsSim =
        row.tags_dist == null || row.tags_dist === undefined
          ? 0
          : distanceToSimilarity(Number(row.tags_dist));
      const memoryTagsStr = String(row.tags || "");
      const contentStr = String(row.content || "");

      // Boundary-aware tag boost (no arbitrary substring): `in` must not
      // boost tag `indexing`.
      const exactMatchBoost = computeTagBoost(memoryTagsStr, queryWords);

      // Recompute lexical coverage from hydrated content/tags for every
      // candidate so a row missed by the bounded lexical candidate scan never
      // keeps a stale keyword score of zero.
      const keywordSim = hasKeyword
        ? computeLexicalCoverage(contentStr, memoryTagsStr, queryWords)
        : 0;
      const finalTagsSim = Math.max(tagsSim, exactMatchBoost);
      // With query text: blend vector + keyword. Without: keep classic 0.6/0.4.
      // Weights are fixed: existing thresholds were calibrated on this scale.
      const raw = hasKeyword
        ? contentSim * 0.5 + finalTagsSim * 0.3 + keywordSim * 0.2
        : contentSim * 0.6 + finalTagsSim * 0.4;
      const similarity = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;

      return {
        id: String(row.id),
        memory: contentStr,
        similarity,
        scoreComponents: {
          content: contentSim,
          tags: finalTagsSim,
          keyword: keywordSim,
        },
        createdAt: Number(row.created_at),
        tags: memoryTagsStr ? memoryTagsStr.split(",") : [],
        metadata: parseMetadata(row.metadata),
        containerTag: String(row.container_tag),
        sessionId: row.session_id ? String(row.session_id) : undefined,
        displayName: row.display_name ? String(row.display_name) : undefined,
        userName: row.user_name ? String(row.user_name) : undefined,
        userEmail: row.user_email ? String(row.user_email) : undefined,
        projectPath: row.project_path ? String(row.project_path) : undefined,
        projectName: row.project_name ? String(row.project_name) : undefined,
        gitRepoUrl: row.git_repo_url ? String(row.git_repo_url) : undefined,
        isPinned: row.is_pinned,
      };
    });

    hydratedResults.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return hydratedResults.slice(0, Math.max(0, limit));
  }

  /**
   * Keyword recall for hybrid ranking.
   * `@tursodatabase/database` does not ship FTS5. At our ~1400-memory scale
   * a scoped projection scan (`id/content/tags/created_at`) with JS
   * boundary-aware scoring avoids per-token candidate truncation and lets us
   * compute all bounded-term coverage before LIMIT with
   * deterministic score/created_at/id ordering. Revisit pagination or FTS
   * if the corpus grows an order of magnitude.
   */
  private async keywordScores(
    db: TursoDb,
    queryText: string | undefined,
    containerTag: string,
    limit: number
  ): Promise<Map<string, number>> {
    const tokens = tokenizeQueryText(queryText);
    if (tokens.length === 0) return new Map();

    const rows = await db.all(
      containerTag === ""
        ? `SELECT id, content, tags, created_at FROM memories`
        : `SELECT id, content, tags, created_at FROM memories WHERE container_tag = ?`,
      containerTag === "" ? [] : [containerTag]
    );
    const scored = rows
      .map((row) => ({
        id: String(row.id),
        coverage: computeLexicalCoverage(String(row.content ?? ""), String(row.tags ?? ""), tokens),
        createdAt: Number(row.created_at ?? 0),
      }))
      .filter((entry) => entry.coverage > 0);
    scored.sort(
      (a, b) =>
        b.coverage - a.coverage ||
        b.createdAt - a.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const scores = new Map<string, number>();
    for (const entry of scored.slice(0, Math.max(0, limit))) {
      scores.set(entry.id, entry.coverage);
    }
    return scores;
  }

  private async exactScanKind(
    db: TursoDb,
    queryJson: string,
    k: number,
    containerTag: string,
    columnName: string
  ): Promise<Array<{ id: string; similarity: number }>> {
    const rows = await db.all(
      containerTag === ""
        ? `
        SELECT m.id AS id, vector_distance_cos(m.${columnName}, vector32(?)) AS dist
        FROM memories m
        WHERE m.${columnName} IS NOT NULL
        ORDER BY dist ASC, m.created_at DESC, m.id ASC
        LIMIT ?
      `
        : `
        SELECT m.id AS id, vector_distance_cos(m.${columnName}, vector32(?)) AS dist
        FROM memories m
        WHERE m.${columnName} IS NOT NULL AND m.container_tag = ?
        ORDER BY dist ASC, m.created_at DESC, m.id ASC
        LIMIT ?
      `,
      containerTag === "" ? [queryJson, k] : [queryJson, containerTag, k]
    );

    return rows.map((row) => ({
      id: String(row.id),
      similarity: distanceToSimilarity(Number(row.dist)),
    }));
  }

  async searchAcrossShards(
    shards: ShardInfo[],
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string
  ): Promise<{ results: SearchResult[]; warnings: string[] }> {
    const shardErrors: Array<{ shardId: number; error: string }> = [];

    const shardPromises = shards.map(async (shard) => {
      try {
        return await this.searchInShard(shard, queryVector, containerTag, limit, queryText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("Shard search error", { shardId: shard.id, error: message });
        shardErrors.push({ shardId: shard.id, error: message });
        return [];
      }
    });

    const resultsArray = await Promise.all(shardPromises);

    if (shardErrors.length > 0 && shardErrors.length === shards.length) {
      throw new Error(
        `Vector search failed on all shards: ${shardErrors.map((entry) => `${entry.shardId}: ${entry.error}`).join("; ")}`
      );
    }

    const warnings =
      shardErrors.length > 0
        ? [
            `Vector search completed with partial shard failures (${shardErrors.length}/${shards.length}): ${shardErrors
              .map((entry) => `${entry.shardId}: ${entry.error}`)
              .join("; ")}`,
          ]
        : [];

    if (warnings.length > 0) {
      log("Vector search completed with partial shard failures", {
        failedShards: shardErrors,
        totalShards: shards.length,
      });
    }

    const allResults = resultsArray.flat();
    allResults.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return {
      results: allResults
        .filter((result) => result.similarity >= similarityThreshold)
        .slice(0, limit),
      warnings,
    };
  }

  async deleteVector(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`DELETE FROM memories WHERE id = ?`, [memoryId]);
  }

  async updateVector(
    db: TursoDb,
    memoryId: string,
    vector: Float32Array,
    tagsVector?: Float32Array
  ): Promise<void> {
    const contentVector = vectorToJson(vector);
    if (tagsVector) {
      await db.execute(
        `UPDATE memories SET vector = vector32(?), tags_vector = vector32(?) WHERE id = ?`,
        [contentVector, vectorToJson(tagsVector), memoryId]
      );
    } else {
      await db.execute(
        `UPDATE memories SET vector = vector32(?), tags_vector = NULL WHERE id = ?`,
        [contentVector, memoryId]
      );
    }
  }

  async listMemories(
    db: TursoDb,
    containerTag: string,
    limit: number
  ): Promise<Record<string, unknown>[]> {
    return containerTag === ""
      ? db.all(
          `
      SELECT * FROM memories
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT ?
    `,
          [limit]
        )
      : db.all(
          `
      SELECT * FROM memories
      WHERE container_tag = ?
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT ?
    `,
          [containerTag, limit]
        );
  }

  async getAllMemories(db: TursoDb): Promise<Record<string, unknown>[]> {
    return db.all(`SELECT * FROM memories ORDER BY created_at DESC`);
  }

  async getAllMemoriesWithExtractedVectors(
    db: TursoDb
  ): Promise<Array<Record<string, unknown> & { vector_json: string | null }>> {
    return db.all(`
      SELECT
        id,
        content,
        container_tag,
        created_at,
        vector_extract(vector) AS vector_json
      FROM memories
      ORDER BY created_at DESC
    `);
  }

  async getMemoryById(db: TursoDb, memoryId: string): Promise<Record<string, unknown> | null> {
    return db.get(`SELECT * FROM memories WHERE id = ?`, [memoryId]);
  }

  async getMemoriesBySessionID(db: TursoDb, sessionID: string): Promise<Record<string, unknown>[]> {
    await this.prepareShardDb(db);
    const rows = await db.all(
      `
      SELECT * FROM memories
      WHERE session_id = ?
         OR (session_id IS NULL AND metadata LIKE ?)
      ORDER BY created_at DESC
    `,
      [sessionID, `%"sessionID":"${sessionID}"%`]
    );

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? String(row.tags).split(",") : [],
      metadata: row.metadata ? (parseMetadata(String(row.metadata)) ?? {}) : {},
    }));
  }

  async countVectors(db: TursoDb, containerTag: string): Promise<number> {
    const row = await db.get(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ?`, [
      containerTag,
    ]);
    return Number(row?.count ?? 0);
  }

  async countAllVectors(db: TursoDb): Promise<number> {
    const row = await db.get(`SELECT COUNT(*) as count FROM memories`);
    return Number(row?.count ?? 0);
  }

  async getDistinctTags(db: TursoDb): Promise<Record<string, unknown>[]> {
    return db.all(`
      SELECT DISTINCT
        container_tag,
        display_name,
        user_name,
        user_email,
        project_path,
        project_name,
        git_repo_url
      FROM memories
    `);
  }

  async getProjectPathCounts(
    db: TursoDb
  ): Promise<Array<{ projectPath: string; count: number; containerTag: string | null }>> {
    const rows = await db.all(`
      SELECT
        project_path AS project_path,
        container_tag AS container_tag,
        COUNT(*) AS cnt
      FROM memories
      WHERE project_path IS NOT NULL AND project_path != ''
      GROUP BY project_path, container_tag
      ORDER BY cnt DESC, project_path ASC
    `);
    return rows.map((row) => ({
      projectPath: String(row.project_path),
      count: Number(row.cnt ?? 0),
      containerTag: row.container_tag ? String(row.container_tag) : null,
    }));
  }

  async updateProjectAssociation(
    db: TursoDb,
    oldContainerTag: string,
    update: {
      containerTag: string;
      projectPath?: string;
      projectName?: string;
      displayName?: string;
      gitRepoUrl?: string | null;
    }
  ): Promise<number> {
    return db.run(
      `
      UPDATE memories SET
        container_tag = ?,
        project_path = ?,
        project_name = ?,
        display_name = ?,
        git_repo_url = ?
      WHERE container_tag = ?
    `,
      [
        update.containerTag,
        update.projectPath ?? null,
        update.projectName ?? null,
        update.displayName ?? null,
        update.gitRepoUrl ?? null,
        oldContainerTag,
      ]
    );
  }

  async pinMemory(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`UPDATE memories SET is_pinned = 1 WHERE id = ?`, [memoryId]);
  }

  async unpinMemory(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`UPDATE memories SET is_pinned = 0 WHERE id = ?`, [memoryId]);
  }
}

export const tursoVectorSearch = new TursoVectorSearch();

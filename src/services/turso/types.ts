import type { JevAssessment } from "../jev-types.js";

export interface ShardInfo {
  id: number;
  scope: "user" | "project";
  scopeHash: string;
  shardIndex: number;
  dbPath: string;
  vectorCount: number;
  isActive: boolean;
  createdAt: number;
}

export interface MemoryRecord {
  id: string;
  content: string;
  vector: Float32Array;
  tagsVector?: Float32Array;
  containerTag: string;
  tags?: string;
  type?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: string;
  /** Indexed OpenCode session id (also mirrored in metadata.sessionID). */
  sessionId?: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export interface SearchResult {
  id: string;
  memory: string;
  similarity: number;
  /** Hybrid retrieval score components, not calibrated confidence probabilities. */
  scoreComponents?: { content: number; tags: number; keyword: number };
  /** Optional decision-model assessment; never replaces hybrid similarity. */
  jev?: JevAssessment;
  containerTag?: string;
  sessionId?: string;
  createdAt?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Session lookup is provenance-based recall, not a semantic similarity score. */
  retrieval?: "session";
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

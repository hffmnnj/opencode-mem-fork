import type { SearchResult } from "./turso/types.js";

export const JEV_MODEL = "jev-1.14.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevRelevance = "relevant" | "irrelevant" | "unknown";

export interface JevAssessment {
  model: typeof JEV_MODEL;
  choice: JevRelevance;
  confidence: number;
  probabilities: Record<JevRelevance, number>;
}

export interface JevConfig {
  enabled: boolean;
  timeoutMs: number;
  maxCandidates: number;
}

export interface JevRerankOptions extends JevConfig {
  apiKey?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface JevRerankResult {
  results: SearchResult[];
  status: "disabled" | "reranked" | "fallback";
  reason?: "missing-key" | "input-limit" | "request-failed" | "invalid-response";
  assessed: number;
  abstained: number;
  latencyMs: number;
}

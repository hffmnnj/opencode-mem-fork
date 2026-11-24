import { describe, expect, it } from "bun:test";
import { formatContextForPrompt, selectContextMemories } from "../src/services/context.js";
import type { SelectContextMemoriesOptions } from "../src/services/context.js";
import { JEV_MODEL } from "../src/services/jev-types.js";
import type { SearchResult } from "../src/services/turso/types.js";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

function makeEntry(
  overrides: Partial<SearchResult> & { id: string; memory: string }
): SearchResult {
  return {
    similarity: 0.8,
    containerTag: "proj",
    createdAt: NOW - 1000,
    ...overrides,
  };
}

function jevChoice(
  choice: "relevant" | "irrelevant" | "unknown",
  relevantProb: number,
  confidence = 0.8
) {
  return {
    model: JEV_MODEL,
    choice,
    confidence,
    probabilities: { relevant: relevantProb, irrelevant: 0.05, unknown: 0.05 },
  };
}

function makeOptions(overrides: Partial<SelectContextMemoriesOptions> = {}) {
  return {
    containerTag: "proj",
    sessionID: "sess-now",
    excludeCurrentSession: true,
    maxMemories: 10,
    similarityThreshold: 0.5,
    now: NOW,
    ...overrides,
  };
}

describe("jev-aware context selection", () => {
  it("preserves adapter order despite conflicting hybrid scores, tail after survivors", () => {
    // Adapter order: assessed relevant first, assessed unknown next,
    // unassessed tail last — even though hybrid scores disagree.
    const adapterOrder = [
      makeEntry({
        id: "relevant-mid",
        memory: "relevant mid",
        similarity: 0.72,
        jev: jevChoice("relevant", 0.9),
      }),
      makeEntry({
        id: "unknown-high",
        memory: "unknown high",
        similarity: 0.95,
        jev: jevChoice("unknown", 0.2),
      }),
      makeEntry({ id: "tail-low", memory: "unassessed tail", similarity: 0.66 }),
    ];
    const selected = selectContextMemories(adapterOrder, makeOptions());
    expect(selected.map((entry) => entry.id)).toEqual(["relevant-mid", "unknown-high", "tail-low"]);
  });

  it("keeps similarity ordering when no entry carries jev metadata", () => {
    const baseline = [
      makeEntry({ id: "mid", memory: "mid memory", similarity: 0.72 }),
      makeEntry({ id: "high", memory: "high memory", similarity: 0.95 }),
      makeEntry({ id: "low", memory: "low memory", similarity: 0.66 }),
    ];
    const selected = selectContextMemories(baseline, makeOptions());
    expect(selected.map((entry) => entry.id)).toEqual(["high", "mid", "low"]);
  });

  it("still applies scope, session, age, and threshold filters with jev present", () => {
    const adapterOrder = [
      makeEntry({
        id: "wrong-scope",
        memory: "other project",
        similarity: 0.9,
        containerTag: "other",
        jev: jevChoice("relevant", 0.9),
      }),
      makeEntry({
        id: "weak",
        memory: "below threshold",
        similarity: 0.4,
        jev: jevChoice("relevant", 0.9),
      }),
      makeEntry({
        id: "current-session",
        memory: "same session",
        similarity: 0.9,
        sessionId: "sess-now",
        jev: jevChoice("relevant", 0.9),
      }),
      makeEntry({
        id: "stale",
        memory: "too old",
        similarity: 0.9,
        createdAt: NOW - 10 * 86400000,
        jev: jevChoice("relevant", 0.9),
      }),
      makeEntry({
        id: "survivor",
        memory: "eligible survivor",
        similarity: 0.7,
        jev: jevChoice("relevant", 0.9),
      }),
    ];
    const selected = selectContextMemories(adapterOrder, makeOptions({ maxAgeDays: 7 }));
    expect(selected.map((entry) => entry.id)).toEqual(["survivor"]);
  });

  it("dedups and caps in adapter order without re-sorting", () => {
    const adapterOrder = [
      makeEntry({
        id: "first",
        memory: "Duplicated  Content",
        similarity: 0.7,
        jev: jevChoice("relevant", 0.9),
      }),
      makeEntry({
        id: "second",
        memory: "unique keeper",
        similarity: 0.95,
        jev: jevChoice("unknown", 0.2),
      }),
      makeEntry({
        id: "third",
        memory: "duplicated content",
        similarity: 0.99,
        jev: jevChoice("unknown", 0.1),
      }),
      makeEntry({
        id: "fourth",
        memory: "extra beyond cap",
        similarity: 0.6,
        jev: jevChoice("unknown", 0.1),
      }),
    ];
    const selected = selectContextMemories(adapterOrder, makeOptions({ maxMemories: 2 }));
    expect(selected.map((entry) => entry.id)).toEqual(["first", "second"]);
  });
});

describe("jev-aware context formatting", () => {
  it("renders escaped jev provenance while keeping hybrid score and similarity", async () => {
    const block = await formatContextForPrompt(null, {
      results: [
        {
          id: 'm-"quoted"',
          memory: 'relevant & <ungarbled> "evidence"',
          similarity: 0.726,
          jev: {
            model: JEV_MODEL,
            choice: "relevant",
            confidence: 0.8,
            probabilities: { relevant: 0.87, irrelevant: 0.12, unknown: 0.01 },
          },
        },
        { id: "plain", memory: "no assessment here", similarity: 0.9 },
      ],
    });
    expect(block).toContain('score="0.726"');
    expect(block).toContain('score_kind="hybrid"');
    expect(block).toContain(`jev_model="${JEV_MODEL}"`);
    expect(block).toContain('jev_relevance="relevant"');
    expect(block).toContain('jev_relevant_prob="0.870"');
    expect(block).toContain('id="m-&quot;quoted&quot;"');
    expect(block).toContain('relevant &amp; &lt;ungarbled&gt; "evidence"');
    const plainLine = block.split("\n").find((line) => line.includes('id="plain"'));
    expect(plainLine).toBeDefined();
    expect(plainLine).not.toContain("jev_");
  });

  it("ignores malformed jev metadata without dropping the memory", async () => {
    const block = await formatContextForPrompt(null, {
      results: [
        {
          id: "odd",
          memory: "still eligible evidence",
          similarity: 0.8,
          jev: { model: 42, choice: "maybe", probabilities: { relevant: "high" } },
        } as unknown as SearchResult,
      ],
    });
    expect(block).toContain("still eligible evidence");
    expect(block).toContain('score_kind="hybrid"');
    expect(block).not.toContain("jev_");
  });
});

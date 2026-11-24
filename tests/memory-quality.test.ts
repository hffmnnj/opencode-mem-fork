import { describe, expect, it } from "bun:test";
import {
  DURABLE_CAPTURE_VERSION,
  metadataAfterContentEdit,
  memoryNature,
  validateCaptureSummary,
  type CaptureSource,
} from "../src/services/memory-quality.js";

const sources: CaptureSource[] = [
  {
    messageId: "msg-1",
    role: "user",
    text: "We decided to use libSQL with a local file so vector search works offline.",
  },
  {
    messageId: "msg-2",
    role: "assistant",
    text: "Wired the capture hook to claim prompts before summarizing to avoid duplicates.",
  },
];

const userQuote = "use libSQL with a local file";
const assistantQuote = "claim prompts before summarizing";

function durableResult(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Use libSQL with a local file so vector search works offline.",
    type: "fact",
    tags: ["storage"],
    evidence: [{ messageId: "msg-1", quote: userQuote }],
    ...overrides,
  };
}

describe("memory-quality durable contract", () => {
  it("removes old evidence when a captured claim is edited", () => {
    const updated = metadataAfterContentEdit(
      JSON.stringify({
        source: "auto-capture",
        captureVersion: 2,
        memoryKind: "fact",
        evidence: [{ quote: "old claim" }],
        codeAnchors: [{ path: "old.ts" }],
        observedAt: 100,
        sessionID: "session-1",
      }),
      200
    );
    expect(JSON.parse(updated!)).toEqual({
      source: "manual",
      previousSource: "auto-capture",
      captureVersion: 2,
      memoryKind: "fact",
      sessionID: "session-1",
      editedAt: 200,
    });
  });

  describe("validateCaptureSummary", () => {
    it("accepts each durable kind with exact excerpts bound to source roles", () => {
      for (const type of ["fact", "decision", "procedure", "pitfall"] as const) {
        const { summary, evidence } = validateCaptureSummary(
          durableResult({
            type,
            evidence: [
              { messageId: "msg-1", quote: userQuote },
              { messageId: "msg-2", quote: assistantQuote },
            ],
          }),
          sources
        );

        expect(summary.type).toBe(type);
        expect(summary.summary.length).toBeGreaterThan(0);
        expect(evidence).toEqual([
          { messageId: "msg-1", role: "user", quote: userQuote },
          { messageId: "msg-2", role: "assistant", quote: assistantQuote },
        ]);
      }
    });

    it("treats a verbatim assistant excerpt as provenance, not verification", () => {
      const { evidence } = validateCaptureSummary(
        durableResult({
          type: "procedure",
          summary: "Claim prompts before summarizing to avoid duplicate captures.",
          evidence: [{ messageId: "msg-2", quote: assistantQuote }],
        }),
        sources
      );

      expect(evidence).toEqual([{ messageId: "msg-2", role: "assistant", quote: assistantQuote }]);
    });

    it("rejects evidence quoting text no source contains", () => {
      expect(() =>
        validateCaptureSummary(
          durableResult({
            evidence: [{ messageId: "msg-1", quote: "migrated the fleet to Postgres" }],
          }),
          sources
        )
      ).toThrow();
    });

    it("rejects evidence pointing at an unknown message", () => {
      expect(() =>
        validateCaptureSummary(
          durableResult({
            evidence: [{ messageId: "msg-9", quote: userQuote }],
          }),
          sources
        )
      ).toThrow();
    });

    it("rejects evidence pairing a real excerpt with the wrong message", () => {
      expect(() =>
        validateCaptureSummary(
          durableResult({
            evidence: [{ messageId: "msg-2", quote: userQuote }],
          }),
          sources
        )
      ).toThrow();
    });

    it("normalizes skip results to empty content and evidence", () => {
      const { summary, evidence } = validateCaptureSummary(
        {
          summary: "nothing durable here",
          type: "skip",
          tags: ["leftover"],
          evidence: [{ messageId: "msg-1", quote: userQuote }],
        },
        sources
      );

      expect(summary).toEqual({ summary: "", type: "skip", tags: [], evidence: [] });
      expect(evidence).toEqual([]);
    });

    it("rejects durable results missing a summary or evidence", () => {
      expect(() => validateCaptureSummary(durableResult({ summary: "" }), sources)).toThrow();
      expect(() => validateCaptureSummary(durableResult({ evidence: [] }), sources)).toThrow();
    });

    it("rejects unsupported capture kinds", () => {
      expect(() =>
        validateCaptureSummary(durableResult({ type: "discussion" }), sources)
      ).toThrow();
    });

    it("rejects oversized summaries and evidence", () => {
      expect(() =>
        validateCaptureSummary(durableResult({ summary: "x".repeat(2401) }), sources)
      ).toThrow();
      expect(() =>
        validateCaptureSummary(
          durableResult({ evidence: [{ messageId: "msg-1", quote: "y".repeat(401) }] }),
          sources
        )
      ).toThrow();
      expect(() =>
        validateCaptureSummary(
          durableResult({
            evidence: [
              { messageId: "msg-1", quote: userQuote },
              { messageId: "msg-2", quote: assistantQuote },
              { messageId: "msg-1", quote: userQuote },
              { messageId: "msg-2", quote: assistantQuote },
            ],
          }),
          sources
        )
      ).toThrow();
    });
  });

  describe("memoryNature", () => {
    it("classifies versioned auto-capture records with a recognized kind as durable", () => {
      expect(
        memoryNature({
          source: "auto-capture",
          captureVersion: DURABLE_CAPTURE_VERSION,
          memoryKind: "decision",
        })
      ).toBe("durable");
    });

    it("keeps legacy auto-capture records historical", () => {
      expect(memoryNature({ source: "auto-capture" })).toBe("historical");
      expect(memoryNature({ source: "auto-capture", captureVersion: 1, memoryKind: "fact" })).toBe(
        "historical"
      );
      expect(
        memoryNature({
          source: "auto-capture",
          captureVersion: DURABLE_CAPTURE_VERSION,
          memoryKind: "discussion",
        })
      ).toBe("historical");
    });

    it("classifies manual and imported records as reference", () => {
      expect(memoryNature(undefined)).toBe("reference");
      expect(memoryNature({})).toBe("reference");
      expect(memoryNature({ source: "manual" })).toBe("reference");
      expect(memoryNature({ source: "import" })).toBe("reference");
    });

    it("does not mutate the metadata it classifies", () => {
      const metadata = Object.freeze({
        source: "auto-capture",
        captureVersion: DURABLE_CAPTURE_VERSION,
        memoryKind: "fact",
      });

      expect(memoryNature(metadata)).toBe("durable");
      expect(metadata).toEqual({
        source: "auto-capture",
        captureVersion: DURABLE_CAPTURE_VERSION,
        memoryKind: "fact",
      });
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CONFIG } from "../src/config.js";
import { buildProfileDigest } from "../src/services/user-profile/profile-context.js";
import type {
  UserProfilePattern,
  UserProfilePreference,
  UserProfileWorkflow,
} from "../src/services/user-profile/types.js";

const NOW = 1_700_000_000_000;
const MAX_DIGEST_CHARS = 1200;

const originalLimits = {
  preferences: CONFIG.userProfileInjectPreferences,
  patterns: CONFIG.userProfileInjectPatterns,
  workflows: CONFIG.userProfileInjectWorkflows,
};

beforeAll(() => {
  // Pin the injected counts so the test does not depend on local config.
  CONFIG.userProfileInjectPreferences = 5;
  CONFIG.userProfileInjectPatterns = 5;
  CONFIG.userProfileInjectWorkflows = 3;
});

afterAll(() => {
  CONFIG.userProfileInjectPreferences = originalLimits.preferences;
  CONFIG.userProfileInjectPatterns = originalLimits.patterns;
  CONFIG.userProfileInjectWorkflows = originalLimits.workflows;
});

function preference(overrides: Partial<UserProfilePreference> = {}): UserProfilePreference {
  return {
    category: "general",
    description: "default preference",
    confidence: 0.8,
    frequency: 2,
    evidence: [],
    lastSeen: NOW,
    ...overrides,
  };
}

function pattern(overrides: Partial<UserProfilePattern> = {}): UserProfilePattern {
  return {
    category: "general",
    description: "default pattern",
    confidence: 0.6,
    frequency: 2,
    evidence: [],
    lastSeen: NOW,
    ...overrides,
  };
}

function workflow(overrides: Partial<UserProfileWorkflow> = {}): UserProfileWorkflow {
  return {
    description: "default workflow",
    steps: [],
    confidence: 0.6,
    frequency: 2,
    evidence: [],
    lastSeen: NOW,
    ...overrides,
  };
}

describe("buildProfileDigest", () => {
  it("renders descriptions without frequency counts, workflow steps or evidence", () => {
    const digest = buildProfileDigest({
      preferences: [
        preference({
          category: "communication",
          description: "Prefer short answers",
          confidence: 0.9,
          frequency: 12,
          evidence: ["EVIDENCE-PREFERENCE"],
        }),
      ],
      patterns: [
        pattern({
          category: "debugging",
          description: "Reproduce failures before changing code",
          confidence: 0.7,
          frequency: 6,
          evidence: ["EVIDENCE-PATTERN"],
        }),
      ],
      workflows: [
        workflow({
          description: "Debug failing tests",
          steps: ["STEP-OPEN-LOGS", "STEP-BISECT"],
          frequency: 7,
          evidence: ["EVIDENCE-WORKFLOW"],
        }),
      ],
      learning_paths: [
        { topic: "Rust", chain: ["ownership"], description: "Learn ownership rules" },
      ],
    });

    expect(digest).not.toBeNull();
    const text = digest!;
    expect(text).toContain("- [communication] Prefer short answers");
    expect(text).toContain("- [debugging] Reproduce failures before changing code");
    expect(text).toContain("- Debug failing tests");
    expect(text).toContain("- Rust: Learn ownership rules");
    expect(text).not.toContain("12x");
    expect(text).not.toContain("(12");
    expect(text).not.toContain("7x");
    expect(text).not.toContain("(7");
    expect(text).not.toContain("STEP-OPEN-LOGS");
    expect(text).not.toContain("STEP-BISECT");
    expect(text).not.toContain("EVIDENCE-");
  });

  it("holds back pending and low-confidence patterns while keeping established legacy patterns", () => {
    const digest = buildProfileDigest({
      preferences: [],
      patterns: [
        pattern({
          category: "pending-a",
          description: "PENDING-A",
          pendingValidation: true,
          confidence: 0.9,
          frequency: 9,
        }),
        pattern({
          category: "pending-b",
          description: "PENDING-B",
          pendingValidation: true,
          confidence: 0.9,
          frequency: 8,
        }),
        pattern({
          category: "pending-c",
          description: "PENDING-C",
          pendingValidation: true,
          confidence: 0.9,
          frequency: 7,
        }),
        pattern({
          category: "low-confidence",
          description: "LOW-CONFIDENCE",
          confidence: 0.1,
          frequency: 6,
        }),
        pattern({
          category: "single-observation",
          description: "SINGLE-OBSERVATION",
          confidence: 0.46,
          frequency: 1,
          pendingValidation: false,
        }),
        pattern({
          category: "legacy-established",
          description: "LEGACY-ESTABLISHED",
          confidence: undefined,
          frequency: 2,
        }),
        pattern({
          category: "legacy-thin",
          description: "LEGACY-THIN",
          confidence: undefined,
          frequency: 1,
        }),
        pattern({
          category: "validated",
          description: "VALIDATED",
          confidence: 0.3,
          frequency: 2,
        }),
      ],
      workflows: [],
    });

    expect(digest).not.toBeNull();
    const text = digest!;
    expect(text).toContain("LEGACY-ESTABLISHED");
    expect(text).toContain("VALIDATED");
    expect(text).not.toContain("PENDING-A");
    expect(text).not.toContain("PENDING-B");
    expect(text).not.toContain("PENDING-C");
    expect(text).not.toContain("LOW-CONFIDENCE");
    expect(text).not.toContain("SINGLE-OBSERVATION");
    expect(text).not.toContain("LEGACY-THIN");
  });

  it("drops over-budget rules whole without truncating their descriptions", () => {
    const descriptions = Array.from(
      { length: 8 },
      (_, index) => `START-${index} ${"x".repeat(300)} END-${index}`
    );
    const digest = buildProfileDigest({
      preferences: descriptions.map((description, index) =>
        preference({
          category: `budget-${index}`,
          description,
          confidence: 0.9,
        })
      ),
      patterns: [],
      workflows: [],
    });

    expect(digest).not.toBeNull();
    const text = digest!;
    expect(text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);

    const starts = [...text.matchAll(/START-(\d+)/g)].map((match) => match[1]);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.length).toBeLessThan(descriptions.length);
    for (const index of starts) {
      expect(text).toContain(`END-${index}`);
    }
  });

  it("escapes markup without rewriting the description", () => {
    const digest = buildProfileDigest({
      preferences: [
        preference({
          category: "safety",
          description: 'Use <b> & "quotes"',
        }),
      ],
      patterns: [],
      workflows: [],
    });

    expect(digest).toBe('User Preferences:\n- [safety] Use &lt;b&gt; &amp; "quotes"');
  });

  it("returns null when no rule survives filtering", () => {
    expect(
      buildProfileDigest({
        preferences: [],
        patterns: [],
        workflows: [],
      })
    ).toBeNull();

    expect(
      buildProfileDigest({
        preferences: [],
        patterns: [
          pattern({
            category: "pending-only",
            description: "PENDING-ONLY",
            pendingValidation: true,
            confidence: 0.9,
            frequency: 9,
          }),
          pattern({
            category: "low-only",
            description: "LOW-ONLY",
            confidence: 0.1,
            frequency: 9,
          }),
        ],
        workflows: [],
      })
    ).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const codeAnchorsUrl = new URL("../src/services/code-anchors.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;

function runScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-auto-capture-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const prompts = [
  {
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    projectPath: "/workspace",
    content: "How does token validation work?",
    createdAt: 1,
    captured: false,
    claimed: false,
    capture_attempts: 0,
  },
  {
    id: "prompt-2",
    sessionId: "session-1",
    messageId: "msg-2",
    projectPath: "/workspace",
    content: "How is export authorized?",
    createdAt: 2,
    captured: false,
    claimed: false,
    capture_attempts: 0,
  },
];
const addCalls = [];
const summaryPrompts = [];
const anchorChecks = [];

function pendingForSession(sessionId) {
  return prompts
    .filter((prompt) => prompt.sessionId === sessionId && !prompt.captured && !prompt.claimed)
    .sort((a, b) => a.createdAt - b.createdAt);
}

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai",
    opencodeModel: "gpt-test",
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (content, _tag, metadata) => {
      addCalls.push({ content, metadata });
      return { success: true, id: \`mem-\${addCalls.length}\` };
    },
    close() {},
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getGitTopLevel: () => "/workspace",
  getTags: () => ({
    project: {
      tag: "opencode_project_test",
      displayName: "Test Project",
      userName: "Test User",
      userEmail: "test@example.com",
      projectPath: "/workspace",
      projectName: "workspace",
      gitRepoUrl: undefined,
    },
  }),
}));

mock.module(${JSON.stringify(codeAnchorsUrl)}, () => ({
  validateCodeAnchors: async (root, candidates, texts) => {
    anchorChecks.push({ root, candidates, texts });
    return [{ ...candidates[0], sha: "a".repeat(40), verifiedAt: "2026-01-02T00:00:00.000Z" }];
  },
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getLastUncapturedPrompt(sessionId) {
      return [...pendingForSession(sessionId)].pop() ?? null;
    },
    getUncapturedPromptsForSession(sessionId) {
      return pendingForSession(sessionId);
    },
    claimPrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || prompt.captured || prompt.claimed) return false;
      prompt.claimed = true;
      return true;
    },
    recordFailedAttempt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.capture_attempts += 1;
    },
    releaseClaim(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || !prompt.claimed || prompt.captured) return false;
      prompt.claimed = false;
      return true;
    },
    linkMemoryToPrompt(id, memoryId) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.linkedMemoryId = memoryId;
    },
    markAsCaptured(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
      }
    },
    deletePrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
        prompt.deleted = true;
      }
    },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      summaryPrompts.push(userPrompt);
      return {
        summary: userPrompt.includes("token validation") ? "Tokens expire after one hour." : "Exports require admin access.",
        type: "fact",
        tags: ["AUTH"],
        evidence: userPrompt.includes("token validation")
          ? [{ messageId: "assistant-1", quote: "Tokens expire after one hour." }]
          : [{ messageId: "assistant-2", quote: "Exports require admin access." }],
        ...(userPrompt.includes("token validation")
          ? { codeAnchors: [{ path: "src/auth.ts", line: 12, quote: "Tokens expire after one hour." }] }
          : {}),
      };
    },
  }),
}));

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture(
  {
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "How does token validation work?" }] },
            { info: { id: "assistant-1", role: "assistant", time: { created: 1000, completed: 2000 } }, parts: [{ type: "text", text: "Tokens expire after one hour." }] },
            { info: { id: "msg-2", role: "user" }, parts: [{ type: "text", text: "How is export authorized?" }] },
            { info: { id: "assistant-2", role: "assistant" }, parts: [{ type: "text", text: "Exports require admin access." }] },
          ],
        }),
      },
      tui: { showToast: async () => ({}) },
    },
  },
  "session-1",
  "/workspace"
);

console.log(
  JSON.stringify({
    addPromptIds: addCalls.map((call) => call.metadata.promptId),
    summaries: addCalls.map((call) => call.content),
    metadata: addCalls.map((call) => call.metadata),
    anchorChecks,
    summaryPrompts,
  })
);
`;

  writeFileSync(scriptPath, script);

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

function runProviderFailureScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-auto-capture-error-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const toasts = [];
let failedAttempts = 0;
let released = false;

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "opencode-go",
    opencodeModel: "deepseek-v4-flash",
    showAutoCaptureToasts: false,
    showErrorToasts: true,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => ({ success: true, id: "unexpected" }),
    close() {},
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    project: {
      tag: "opencode_project_test",
      displayName: "Test Project",
      projectPath: "/workspace",
    },
  }),
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getUncapturedPromptsForSession: async () => [{
      id: "prompt-error",
      sessionId: "session-error",
      messageId: "msg-error",
      projectPath: "/workspace",
      content: "Implement the requested change",
      createdAt: 1,
      captured: false,
      capture_attempts: 0,
    }],
    claimPrompt: async () => true,
    recordFailedAttempt: async () => { failedAttempts += 1; },
    releaseClaim: async () => { released = true; return true; },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async () => {
      throw new Error(
        "opencode-mem: opencode reported APIError: Thinking mode does not support this tool_choice"
      );
    },
  }),
}));

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture(
  {
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg-error", role: "user" }, parts: [{ type: "text", text: "Implement the requested change" }] },
            { info: { id: "assistant-error", role: "assistant" }, parts: [{ type: "text", text: "Implemented it" }] },
          ],
        }),
      },
      tui: { showToast: async (toast) => { toasts.push(toast); return {}; } },
    },
  },
  "session-error",
  "/workspace"
);

console.log(JSON.stringify({ toasts, failedAttempts, released }));
`;

  writeFileSync(scriptPath, script);

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

function runBoundaryScenario(provider: "opencode" | "external", output: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-capture-boundary-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";
const writes = [], requests = [];
let failedAttempts = 0, released = 0, deleted = 0, listed = 0;
const output = ${JSON.stringify(output)};
mock.module(${JSON.stringify(configUrl)}, () => ({ CONFIG: {
  autoCaptureMaxRetries: 1, autoCaptureProviderStatus: { ready: true }, autoCaptureLanguage: "en",
  ${provider === "opencode" ? 'opencodeProvider: "test", opencodeModel: "test",' : 'memoryProvider: "test", memoryModel: "test", memoryApiUrl: "http://invalid",'}
  showAutoCaptureToasts: false, showErrorToasts: false,
} }));
mock.module(${JSON.stringify(clientUrl)}, () => ({ memoryClient: {
  listMemories: async () => { listed++; return { success: true, memories: [{ summary: "stale prior secret" }] }; },
  addMemory: async (content, tag, metadata) => { writes.push({ content, tag, metadata }); return { success: true, id: "m" }; },
} }));
mock.module(${JSON.stringify(tagsUrl)}, () => ({ getTags: () => ({ project: { tag: "project", displayName: "Project" } }) }));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({ userPromptManager: {
  getUncapturedPromptsForSession: async () => [{ id: "p", messageId: "user-id", content: "How does the cache work? <private>user secret</private>", capture_attempts: 0 }],
  claimPrompt: async () => true,
  recordFailedAttempt: async () => { failedAttempts++; },
  releaseClaim: async () => { released++; },
  deletePrompt: async () => { deleted++; },
  linkMemoryToPrompt: async () => {}, markAsCaptured: async () => {},
} }));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({ detectLanguage: () => "en", getLanguageName: () => "English" }));
mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({ loadOpencodeProvider: async () => ({
  ensureProviderConnected: async () => true, getV2Client: () => ({}),
  generateStructuredOutput: async ({ systemPrompt, userPrompt }) => { requests.push({ systemPrompt, userPrompt }); return output; },
}) }));
mock.module(${JSON.stringify(new URL("../src/services/ai/ai-provider-factory.js", import.meta.url).href)}, () => ({
  AIProviderFactory: { createProvider: () => ({ executeToolCall: async (systemPrompt, userPrompt, schema) => {
    requests.push({ systemPrompt, userPrompt, schema }); return { success: true, data: output };
  } }) },
}));
mock.module(${JSON.stringify(new URL("../src/services/ai/provider-config.js", import.meta.url).href)}, () => ({ buildMemoryProviderConfig: () => ({}) }));
const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture({ client: { session: { messages: async () => ({ data: [
  { info: { id: "user-id", role: "user" }, parts: [] },
  { info: { id: "assistant-id", role: "assistant" }, parts: [
    { type: "text", text: output.type === "skip" ? "I am reading the files." : "The cache expires after one hour. <private>assistant secret</private>" },
    { type: "text", text: "synthetic secret", synthetic: true },
    { type: "text", text: "ignored secret", ignored: true },
    { type: "tool", tool: "read", state: { input: { path: "tool input secret" }, output: "tool output secret" } },
  ] },
  { info: { id: "private-id", role: "assistant" }, parts: [{ type: "text", text: "<private>private only</private>" }] },
  { info: { id: "summary-id", role: "assistant", summary: true }, parts: [{ type: "text", text: "compaction secret" }] },
  { info: { id: "mode-id", role: "assistant", mode: "compaction" }, parts: [{ type: "text", text: "mode secret" }] },
] }) }, tui: { showToast: async () => ({}) } } }, "session", "/workspace");
console.log(JSON.stringify({ writes, requests, failedAttempts, released, deleted, listed }));
`;
  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  return {
    exitCode: result.exitCode,
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

function runVariantScenario(opencodeModel: string, opencodeVariant?: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-auto-capture-variant-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const generateCalls = [];

const prompts = [
  {
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    projectPath: "/workspace",
    content: "How does token validation work?",
    createdAt: 1,
    captured: false,
    claimed: false,
    capture_attempts: 0,
    // Recorded via chat.params so "inherit" resolves to this model.
    providerId: "newapi",
    modelId: "recorded-model",
  },
];

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "newapi",
    opencodeModel: ${JSON.stringify(opencodeModel)},
    ${opencodeVariant === undefined ? "" : `opencodeVariant: ${JSON.stringify(opencodeVariant)},`}
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => ({ success: true, id: "mem-variant" }),
    close() {},
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    project: {
      tag: "opencode_project_test",
      displayName: "Test Project",
      userName: "Test User",
      userEmail: "test@example.com",
      projectPath: "/workspace",
      projectName: "workspace",
      gitRepoUrl: undefined,
    },
  }),
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getLastUncapturedPrompt: (sessionId) =>
      prompts.find((p) => p.sessionId === sessionId && !p.captured && !p.claimed) ?? null,
    getUncapturedPromptsForSession: (sessionId) =>
      prompts.filter((p) => p.sessionId === sessionId && !p.captured && !p.claimed),
    claimPrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || prompt.captured || prompt.claimed) return false;
      prompt.claimed = true;
      return true;
    },
    recordFailedAttempt() {},
    releaseClaim(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.claimed = false;
      return true;
    },
    linkMemoryToPrompt() {},
    markAsCaptured(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
      }
    },
    deletePrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.captured = true;
    },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async (args) => {
      generateCalls.push({
        providerID: args.providerID,
        modelID: args.modelID,
        variant: args.variant,
      });
      return { summary: "Tokens expire after one hour.", type: "fact", tags: [], evidence: [{ messageId: "assistant-1", quote: "Tokens expire after one hour." }] };
    },
  }),
}));

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture(
  {
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "How does token validation work?" }] },
            { info: { id: "assistant-1", role: "assistant" }, parts: [{ type: "text", text: "Tokens expire after one hour." }] },
          ],
        }),
      },
      tui: { showToast: async () => ({}) },
    },
  },
  "session-1",
  "/workspace"
);

console.log(JSON.stringify({ generateCalls }));
`;

  writeFileSync(scriptPath, script);

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("auto-capture idle processing", () => {
  for (const provider of ["opencode", "external"] as const) {
    it(`${provider} persists grounded knowledge and excludes private, synthetic, tool and stale data`, () => {
      const result = runBoundaryScenario(provider, {
        summary: "The cache expires after one hour.",
        type: "fact",
        tags: ["CACHE"],
        evidence: [{ messageId: "assistant-id", quote: "The cache expires after one hour." }],
      });
      expect([result.exitCode, result.stderr]).toEqual([0, ""]);
      expect(result.parsed.writes).toHaveLength(1);
      expect(result.parsed.writes[0].metadata).toMatchObject({
        captureVersion: 2,
        memoryKind: "fact",
        sourceMessageId: "user-id",
        evidence: [
          {
            messageId: "assistant-id",
            role: "assistant",
            quote: "The cache expires after one hour.",
          },
        ],
      });
      expect(result.parsed.listed).toBe(0);
      const request = result.parsed.requests[0];
      expect(request.systemPrompt).toContain("reusable technical knowledge");
      expect(request.userPrompt).toContain("The cache expires after one hour.");
      for (const hidden of [
        "user secret",
        "assistant secret",
        "synthetic secret",
        "ignored secret",
        "tool input secret",
        "tool output secret",
        "private only",
        "compaction secret",
        "mode secret",
        "stale prior secret",
      ]) {
        expect(request.userPrompt).not.toContain(hidden);
      }
      expect(result.parsed.failedAttempts).toBe(0);
    });

    it(`${provider} rejects unsupported or legacy evidence and releases the claim`, () => {
      const invalidEvidence = [
        { messageId: "assistant-id", quote: "not in the source" },
        { messageId: "assistant-id", quote: "assistant secret" },
        { messageId: "assistant-id", quote: "synthetic secret" },
        { messageId: "assistant-id", quote: "ignored secret" },
        { messageId: "private-id", quote: "[REDACTED]" },
        { messageId: "summary-id", quote: "compaction secret" },
        { messageId: "mode-id", quote: "mode secret" },
      ];
      const outputs: unknown[] = invalidEvidence.map((item) => ({
        summary: "Unsupported claim",
        type: "fact",
        tags: [],
        evidence: [item],
      }));
      outputs.push({ summary: "Old ungrounded record", type: "discussion", tags: [] });
      for (const output of outputs) {
        const result = runBoundaryScenario(provider, output);
        expect([result.exitCode, result.stderr]).toEqual([0, ""]);
        expect(result.parsed.writes).toEqual([]);
        expect(result.parsed.failedAttempts).toBe(1);
        expect(result.parsed.released).toBe(1);
        expect(result.parsed.deleted).toBe(0);
      }
    });

    it(`${provider} deletes a progress-only skip without persisting it`, () => {
      const result = runBoundaryScenario(provider, {
        summary: "",
        type: "skip",
        tags: [],
        evidence: [],
      });
      expect([result.exitCode, result.stderr]).toEqual([0, ""]);
      expect(result.parsed.writes).toEqual([]);
      expect(result.parsed.deleted).toBe(1);
      expect(result.parsed.failedAttempts).toBe(0);
    });
  }

  it("captures all uncaptured prompts in a session in chronological response windows", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.addPromptIds).toEqual(["prompt-1", "prompt-2"]);
    expect(result.parsed?.summaries).toEqual([
      "Tokens expire after one hour.\n\nTags: auth",
      "Exports require admin access.\n\nTags: auth",
    ]);
    expect(result.parsed?.summaryPrompts[0]).toContain("Tokens expire after one hour.");
    expect(result.parsed?.summaryPrompts[0]).not.toContain("Exports require admin access.");
    expect(result.parsed?.summaryPrompts[1]).toContain("Exports require admin access.");
    expect(result.parsed?.metadata[0].observedAt).toBe(2000);
    expect(result.parsed?.metadata[1].observedAt).toBeUndefined();
    expect(result.parsed?.metadata[0].codeAnchors).toEqual([
      {
        path: "src/auth.ts",
        line: 12,
        quote: "Tokens expire after one hour.",
        sha: "a".repeat(40),
        verifiedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(result.parsed?.anchorChecks[0].texts).toContain("Tokens expire after one hour.");
    expect(result.parsed?.anchorChecks).toHaveLength(1);
    expect(
      result.parsed?.metadata.map(({ captureVersion, memoryKind, sourceMessageId, evidence }) => ({
        captureVersion,
        memoryKind,
        sourceMessageId,
        evidence,
      }))
    ).toEqual([
      {
        captureVersion: 2,
        memoryKind: "fact",
        sourceMessageId: "msg-1",
        evidence: [
          { messageId: "assistant-1", role: "assistant", quote: "Tokens expire after one hour." },
        ],
      },
      {
        captureVersion: 2,
        memoryKind: "fact",
        sourceMessageId: "msg-2",
        evidence: [
          { messageId: "assistant-2", role: "assistant", quote: "Exports require admin access." },
        ],
      },
    ]);
  });

  it("preserves the opencode provider error when no manual fallback is configured", () => {
    const result = runProviderFailureScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.failedAttempts).toBe(1);
    expect(result.parsed?.released).toBe(true);
    expect(result.parsed?.toasts).toHaveLength(1);
    const message = result.parsed?.toasts[0]?.body?.message ?? "";
    expect(message).toContain("Thinking mode does not support");
    expect(message).not.toContain("External API not configured");
  });

  it("forwards CONFIG.opencodeVariant to the structured-output helper for a configured model", () => {
    const result = runVariantScenario("grok-4.7", "xhigh");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.generateCalls).toHaveLength(1);
    expect(result.parsed?.generateCalls[0]).toEqual({
      providerID: "newapi",
      modelID: "grok-4.7",
      variant: "xhigh",
    });
  });

  it("forwards opencodeVariant even when opencodeModel is inherit", () => {
    const result = runVariantScenario("inherit", "xhigh");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.generateCalls).toHaveLength(1);
    expect(result.parsed?.generateCalls[0]).toEqual({
      providerID: "newapi",
      modelID: "recorded-model",
      variant: "xhigh",
    });
  });

  it("omits variant when opencodeVariant is unset under inherit", () => {
    const result = runVariantScenario("inherit");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.generateCalls).toHaveLength(1);
    expect(result.parsed?.generateCalls[0]).toEqual({
      providerID: "newapi",
      modelID: "recorded-model",
      variant: undefined,
    });
  });
});

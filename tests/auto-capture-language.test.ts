import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;
const aiProviderFactoryUrl = new URL("../src/services/ai/ai-provider-factory.js", import.meta.url)
  .href;
const providerConfigUrl = new URL("../src/services/ai/provider-config.js", import.meta.url).href;

type ScenarioOptions = {
  transport: "direct" | "opencode";
  prompt: string;
  assistantContext: string;
  toolContext: string;
  previousMemory: string;
  language?: string;
};

function runScenario(options: ScenarioOptions) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-auto-capture-language-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

let capturedSystemPrompt = null;
let capturedUserPrompt = null;
const prompt = ${JSON.stringify(options.prompt)};
const assistantContext = ${JSON.stringify(options.assistantContext)};
const toolContext = ${JSON.stringify(options.toolContext)};
const previousMemory = ${JSON.stringify(options.previousMemory)};
const transport = ${JSON.stringify(options.transport)};

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: ${JSON.stringify(options.language)},
    opencodeProvider: transport === "opencode" ? "test-provider" : undefined,
    opencodeModel: transport === "opencode" ? "test-model" : undefined,
    memoryProvider: "openai",
    memoryModel: transport === "direct" ? "direct-model" : undefined,
    memoryApiUrl: transport === "direct" ? "https://unused.invalid/v1" : undefined,
    memoryApiKey: transport === "direct" ? "test-key" : undefined,
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [{ summary: previousMemory }] }),
    addMemory: async () => ({ success: true, id: "saved-memory" }),
    close() {},
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    project: { tag: "opencode_project_test", displayName: "Test Project", projectPath: "/workspace" },
  }),
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getUncapturedPromptsForSession: async () => [{
      id: "prompt-1", sessionId: "session-1", messageId: "msg-user", projectPath: "/workspace",
      content: prompt, createdAt: 1, captured: false, capture_attempts: 0,
    }],
    claimPrompt: async () => true,
    recordFailedAttempt: async () => {},
    releaseClaim: async () => true,
    linkMemoryToPrompt: async () => {},
    markAsCaptured: async () => {},
    deletePrompt: async () => {},
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ systemPrompt, userPrompt }) => {
      capturedSystemPrompt = systemPrompt;
      capturedUserPrompt = userPrompt;
      return { summary: "captured", type: "feature", tags: [] };
    },
  }),
}));

mock.module(${JSON.stringify(aiProviderFactoryUrl)}, () => ({
  AIProviderFactory: {
    createProvider: () => ({
      executeToolCall: async (systemPrompt, userPrompt) => {
        capturedSystemPrompt = systemPrompt;
        capturedUserPrompt = userPrompt;
        return { success: true, data: { summary: "captured", type: "feature", tags: [] } };
      },
    }),
  },
}));
mock.module(${JSON.stringify(providerConfigUrl)}, () => ({ buildMemoryProviderConfig: () => ({}) }));

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture({
  client: {
    session: {
      messages: async () => ({
        data: [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: prompt }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [
              { type: "text", text: assistantContext },
              { type: "tool", tool: "search", state: { input: { query: toolContext } } },
            ],
          },
        ],
      }),
    },
    tui: { showToast: async () => ({}) },
  },
}, "session-1", "/workspace");

console.log(JSON.stringify({ systemPrompt: capturedSystemPrompt, userPrompt: capturedUserPrompt }));
`;

  writeFileSync(scriptPath, script, "utf-8");
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
    parsed: stdout ? (JSON.parse(stdout) as { systemPrompt: string; userPrompt: string }) : null,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("auto-capture output language", () => {
  it("uses the English prompt rather than Dutch assistant, tool, or memory context with OpenCode", () => {
    const result = runScenario({
      transport: "opencode",
      prompt: "Please add a regression test for this login bug",
      assistantContext: "Ik heb de fout in het inloggen hersteld.",
      toolContext: "Zoek naar de inlogfunctie en voeg een regressietest toe.",
      previousMemory: "De loginfout wordt veroorzaakt door een ontbrekende controle.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.systemPrompt).toContain(
      "You MUST write the summary in English, including section headings."
    );
    expect(result.parsed?.systemPrompt).toContain(
      "ignore language in assistant responses, tools, previous memories"
    );
  });

  it("uses the Dutch prompt rather than English assistant, tool, or memory context on the direct provider path", () => {
    const result = runScenario({
      transport: "direct",
      prompt: "Voeg een regressietest toe en herstel de fout in het inloggen.",
      assistantContext: "I fixed the login bug and added a regression test.",
      toolContext: "Search for the login handler and test coverage.",
      previousMemory: "The login endpoint checks credentials before reading the session.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.systemPrompt).toContain(
      "You MUST write the summary in Dutch, including section headings."
    );
  });

  it("honors an explicit language-code override even when the current prompt is English", () => {
    const result = runScenario({
      transport: "direct",
      prompt: "Please add a regression test for this login bug",
      assistantContext: "I fixed the login bug.",
      toolContext: "Run the login tests.",
      previousMemory: "The login service uses token authentication.",
      language: "fr",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.systemPrompt).toContain(
      "You MUST write the summary in French, including section headings."
    );
  });

  it("does not force an inferred language for mixed prompts", () => {
    const result = runScenario({
      transport: "opencode",
      prompt: "Please fix the login bug; voeg ook tests toe.",
      assistantContext: "Implemented the change.",
      toolContext: "Build passed.",
      previousMemory: "Previous technical note.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.systemPrompt).toContain("mixed or ambiguous prompts");
    expect(result.parsed?.systemPrompt).toContain(
      "language that dominates the current user's prompt"
    );
    expect(result.parsed?.systemPrompt).not.toContain("language-neutral");
    expect(result.parsed?.systemPrompt).not.toContain("You MUST write the summary in");
  });

  for (const prompt of ["Get generate image plugin working ASAP", "Is generate_image working?"]) {
    it(`keeps the current prompt language for brief English request: ${prompt}`, () => {
      const result = runScenario({
        transport: "opencode",
        prompt,
        assistantContext: "Ik heb de wijziging uitgevoerd en de fout hersteld.",
        toolContext: "Controleer de code en voer de regressietest uit.",
        previousMemory: "De afbeeldingengenerator is gekoppeld aan de projectconfiguratie.",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.parsed?.systemPrompt).toContain(
        "Infer and write the summary in the language of the current user's prompt"
      );
      expect(result.parsed?.systemPrompt).toContain(
        "Ignore language in assistant responses, tools, previous memories, and this English template as language evidence"
      );
      expect(result.parsed?.systemPrompt).not.toContain("You MUST write the summary in Dutch");
      expect(result.parsed?.systemPrompt).not.toContain("language-neutral");
    });
  }

  it("abstains when a short English prompt would otherwise be misdetected as Dutch", () => {
    const result = runScenario({
      transport: "opencode",
      prompt: "Make sure it works",
      assistantContext: "De wijziging is uitgevoerd.",
      toolContext: "De tests zijn groen.",
      previousMemory: "Deze loginfunctie vereist een extra controle.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.systemPrompt).toContain(
      "Infer and write the summary in the language of the current user's prompt"
    );
    expect(result.parsed?.systemPrompt).not.toContain("You MUST write the summary in Dutch");
    expect(result.parsed?.systemPrompt).not.toContain("language-neutral");
  });

  it("does not treat code-only prompts as English even with non-English conversation context", () => {
    const result = runScenario({
      transport: "opencode",
      prompt: "```ts\nconst patched = true;\n```",
      assistantContext: "Ik heb de aanpassing uitgevoerd.",
      toolContext: "De tests zijn groen.",
      previousMemory: "De code wordt gebruikt in het inlogproces.",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.systemPrompt).toContain("no natural-language text appears");
    expect(result.parsed?.systemPrompt).not.toContain("language-neutral");
    expect(result.parsed?.systemPrompt).not.toContain("You MUST write the summary in");
  });
});

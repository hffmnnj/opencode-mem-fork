import { mock } from "bun:test";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const config = {
  chatMessage: {
    enabled: true,
    injectOn: "first",
    maxMemories: 3,
    excludeCurrentSession: true,
    filterInjectedPrompts: true,
  },
  similarityThreshold: 0.58,
  memory: { defaultScope: "project" },
  compaction: { enabled: false },
  autoCaptureEnabled: false,
  webServerEnabled: false,
  autoUpdate: { enabled: false },
  storagePath: process.argv[2],
  opencodeModel: "inherit",
};
let configured = true;
let memories = [{ summary: "original project knowledge", createdAt: new Date().toISOString() }];
let failLookup = false;
let lookupCount = 0;
const captures = [];
const queries = [];
const histories = new Map();
const titles = new Map();
mock.module(moduleUrl("config"), () => ({
  CONFIG: config,
  initConfig() {},
  isConfigured: () => configured,
}));
mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    warmup: async () => {},
    close: async () => {},
    searchMemories: async (query, tag, scope, options) => {
      lookupCount++;
      queries.push({ query, tag, scope, limit: options?.limit });
      if (failLookup) throw new Error("fixture lookup failure");
      return {
        success: true,
        results: memories.map((m) => ({
          id: m.summary,
          memory: m.summary,
          similarity: m.similarity ?? 0.73,
          createdAt: new Date(m.createdAt).getTime(),
          metadata: m.metadata,
          containerTag: m.containerTag ?? tag,
        })),
      };
    },
  },
}));
mock.module(moduleUrl("services/tags"), () => ({
  getTags: () => ({
    project: { tag: "fixture-project" },
    user: { userEmail: "fixture-user" },
  }),
}));
const { selectContextMemories, formatContextForPrompt: realFormatContext } = await import(
  moduleUrl("services/context")
);
let useRealFormatter = false;
mock.module(moduleUrl("services/context"), () => ({
  selectContextMemories,
  formatContextForPrompt: async (_user, data, options) =>
    useRealFormatter
      ? realFormatContext(_user, data, options)
      : data.results.length
        ? "<memory_context>" + data.results.map((m) => m.memory).join("|") + "</memory_context>"
        : "",
}));
mock.module(moduleUrl("services/user-prompt/user-prompt-manager"), () => ({
  userPromptManager: {
    savePrompt: async (...args) => captures.push(args),
    setPromptModel: async () => {},
  },
}));
mock.module(moduleUrl("services/logger"), () => ({ log() {} }));
mock.module(moduleUrl("services/web-server"), () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(moduleUrl("services/auto-update"), () => ({ startAutoUpdate() {} }));
const { OpenCodeMemPlugin } = await import(moduleUrl("index"));
const { registerV2Adapter } = await import(moduleUrl("v2/adapter"));
const client = {
  provider: { list: async () => ({ data: { connected: [] } }) },
  session: {
    messages: async ({ path }) => ({ data: histories.get(path.id) ?? [] }),
    get: async ({ path }) => ({ data: { title: titles.get(path.id) ?? "regular task" } }),
  },
};
const plugin = await OpenCodeMemPlugin({ directory: "/fixture-project", client });
async function adapter() {
  const hooks = new Map();
  const cleanup = await registerV2Adapter(
    {
      location: {
        directory: "/fixture-project",
        project: { directory: "/fixture-project" },
      },
      tool: { transform: async () => {} },
      session: { hook: async (name, callback) => hooks.set(name, callback) },
    },
    { ...plugin, event: undefined, dispose: undefined }
  );
  return {
    async prompt(sessionID, text, id) {
      const event = { sessionID, messageID: id, prompt: { text } };
      await hooks.get("prompt")(event);
      const history = histories.get(sessionID) ?? [];
      history.push({
        info: { role: "user", id },
        parts: [{ type: "text", text }],
      });
      histories.set(sessionID, history);
      return event.prompt.text;
    },
    async context(sessionID) {
      const transientBrand = Symbol.for("opencode.transient-context.v1");
      const event = {
        sessionID,
        model: { providerID: "fixture", id: "fixture" },
        system: [],
        messages: [],
      };
      await hooks.get("context")(event);
      if (event.system.length !== 0) {
        throw new Error("memory context leaked into the fixed system prefix");
      }
      return event.messages
        .filter((message) => message?.[transientBrand] === "memory")
        .map((message) =>
          Array.isArray(message?.content)
            ? message.content
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join("\n")
            : message?.text
        );
    },
    cleanup,
  };
}
const output = {};
let host = await adapter();
output.authored = await host.prompt("first", "authored first prompt", "msg-1");
output.first = await host.context("first");
memories = [{ summary: "new project knowledge", createdAt: new Date().toISOString() }];
await host.prompt("first", "authored second prompt", "msg-2");
output.second = await host.context("first");
output.modelStep = await host.context("first");
output.firstLookups = lookupCount;
await host.cleanup();
host = await adapter();
const capturesBeforeReload = captures.length;
output.resumed = await host.context("first");
output.resumeCaptured = captures.length - capturesBeforeReload;
await host.prompt("first", "authored after reload", "msg-3");
output.afterResume = await host.context("first");
memories = [{ summary: "other session knowledge", createdAt: new Date().toISOString() }];
output.noHistory = await host.context("unknown");
histories.set("other", [
  { info: { role: "user" }, parts: [{ type: "text", text: "other project query" }] },
]);
output.otherSession = await host.context("other");
output.originalSessionAfterOther = await host.context("first");
config.chatMessage.injectOn = "always";
await host.prompt("always", "first always prompt", "msg-4");
output.alwaysFirst = await host.context("always");
memories = [{ summary: "refreshed project knowledge", createdAt: new Date().toISOString() }];
await host.prompt("always", "second always prompt", "msg-5");
output.alwaysSecond = await host.context("always");
memories = [];
await host.prompt("always", "empty lookup prompt", "msg-6");
output.empty = await host.context("always");
memories = [{ summary: "after empty lookup", createdAt: new Date().toISOString() }];
await host.prompt("always", "recovery prompt", "msg-7");
output.recovered = await host.context("always");
failLookup = true;
await host.prompt("always", "failed lookup prompt", "msg-8");
output.failed = await host.context("always");
failLookup = false;
await host.prompt("always", "retry prompt", "msg-9");
output.retried = await host.context("always");
config.chatMessage.maxContextChars = 0;
output.budgetDisabled = await host.context("always");
delete config.chatMessage.maxContextChars;
config.chatMessage.enabled = false;
output.disabled = await host.context("always");
config.chatMessage.enabled = true;
configured = false;
output.unconfigured = await host.context("always");
configured = true;
await host.prompt("first", "# User Profile Analysis", "internal-1");
output.internalPrompt = await host.context("first");
await host.prompt("first", "<system-reminder>injected boilerplate</system-reminder>", "internal-2");
output.injectedOnly = await host.context("first");
await host.prompt("first", "   ", "internal-3");
output.blank = await host.context("first");
await host.prompt("first", "back to real work", "msg-10");
output.realAfterInternal = await host.context("first");
await host.cleanup();
host = await adapter();
const capturesBeforeAlwaysResume = captures.length;
output.alwaysResumed = await host.context("always");
output.alwaysResumeCaptured = captures.length - capturesBeforeAlwaysResume;
config.chatMessage.injectOn = "first";
memories = [{ summary: "cold prompt knowledge", createdAt: new Date().toISOString() }];
await host.prompt("first", "first prompt after cold reload", "msg-11");
output.coldPrompt = await host.context("first");
config.chatMessage.maxAgeDays = 1;
memories = [
  {
    summary: "eligible knowledge",
    metadata: { observedAt: 123456789 },
    createdAt: new Date().toISOString(),
  },
  {
    summary: "excluded current session",
    metadata: { sessionID: "filtered" },
    createdAt: new Date().toISOString(),
  },
  { summary: "expired knowledge", createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
  { summary: "below threshold", similarity: 0.2, createdAt: new Date().toISOString() },
  { summary: "wrong scope", containerTag: "other-project", createdAt: new Date().toISOString() },
];
histories.set("filtered", [
  { info: { role: "user" }, parts: [{ type: "text", text: "filtered query" }] },
]);
output.filteredResume = await host.context("filtered");
config.similarityThreshold = 0.8;
output.stricterThreshold = await host.context("filtered");
config.similarityThreshold = 0.58;
output.restoredThreshold = await host.context("filtered");
await host.prompt(
  "mixed",
  "<memory_context>injected text</memory_context>\nactual ranking query",
  "msg-12"
);
output.mixed = await host.context("mixed");
output.queries = queries;
titles.set("internal", "opencode-mem capture");
output.internalResume = await host.context("internal");
output.captures = captures.map(([sessionID, messageID, , text]) => ({
  sessionID,
  messageID,
  text,
}));
const restoredCapturesBefore = captures.length;
await host.prompt(
  "first",
  "## Restored Session Memory\n\nstale notes should not record",
  "msg-restored"
);
output.restoredPrompt = await host.context("first");
output.restoredCapturedDelta = captures.length - restoredCapturesBefore;
const memoriesBeforeRestoredCold = memories;
memories = [{ summary: "restored cold knowledge", createdAt: new Date().toISOString() }];
histories.set("restored-cold", [
  { info: { role: "user" }, parts: [{ type: "text", text: "earlier authored cold query" }] },
  {
    info: { role: "user" },
    parts: [{ type: "text", text: "## Restored Session Memory\n\nstale trailing notes" }],
  },
  {
    info: { role: "user" },
    parts: [{ type: "text", text: "synthetic follow-up", synthetic: true }],
  },
]);
output.restoredCold = await host.context("restored-cold");
output.restoredColdQuery = queries[queries.length - 1]?.query;
memories = memoriesBeforeRestoredCold;
// V1 still injects synthetic message parts according to its history policy.
const v1 = {
  message: { id: "v1-first" },
  parts: [{ type: "text", text: "v1 user prompt" }],
};
await plugin["chat.message"]({ sessionID: "v1" }, v1);
output.v1First = v1.parts;
histories.set("v1", [{ info: { role: "user" }, parts: [{ type: "text", text: "prior" }] }]);
const later = {
  message: { id: "v1-later" },
  parts: [{ type: "text", text: "later v1 prompt" }],
};
await plugin["chat.message"]({ sessionID: "v1" }, later);
output.v1Later = later.parts;
output.search = JSON.parse(
  await plugin.tool.memory.execute({ mode: "search", query: "explicit query", limit: 1 })
);
output.zeroSearch = JSON.parse(
  await plugin.tool.memory.execute({ mode: "search", query: "explicit query", limit: 0 })
);
useRealFormatter = true;
config.chatMessage.maxMemories = 2;
config.chatMessage.maxContextChars = 900;
memories = [
  {
    summary: "oversized " + "x".repeat(10000),
    similarity: 0.99,
    createdAt: new Date().toISOString(),
  },
  { summary: "packing survivor alpha", similarity: 0.9, createdAt: new Date().toISOString() },
  { summary: "packing survivor beta", similarity: 0.8, createdAt: new Date().toISOString() },
  { summary: "packing extra gamma", similarity: 0.7, createdAt: new Date().toISOString() },
];
await host.prompt("packing", "pack complete memories", "msg-packing");
output.packing = await host.context("packing");
await host.cleanup();
await plugin.dispose();
console.log(JSON.stringify(output));

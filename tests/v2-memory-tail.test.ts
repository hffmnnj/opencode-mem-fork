import { describe, expect, it } from "bun:test";
import { Message } from "@opencode/ai";
import { registerV2Adapter } from "../src/v2/adapter.js";

const BRAND = Symbol.for("opencode.transient-context.v1");

function textOf(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text ?? "")
    .join("\n");
}

async function host(options: {
  load: (sessionID: string, query?: string) => Promise<string>;
  enabled?: boolean;
  refreshOnPrompt?: boolean;
  cacheKey?: () => string;
  capture?: (input: any, output: any) => Promise<boolean>;
}) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const cleanup = await registerV2Adapter(
    {
      location: { directory: "/workspace/project" },
      tool: { transform: async () => {} },
      session: {
        hook: async (name: string, callback: (event: any) => Promise<void>) => {
          hooks.set(name, callback);
        },
      },
    } as any,
    {
      tool: { memory: { description: "memory" } },
      memoryContext: {
        enabled: () => options.enabled ?? true,
        refreshOnPrompt: () => options.refreshOnPrompt ?? true,
        cacheKey: options.cacheKey,
        capturePrompt: options.capture ?? (async () => true),
        load: options.load,
      },
    }
  );
  return {
    cleanup,
    prompt: (messageID: string, text = messageID) =>
      hooks.get("prompt")!({ sessionID: "session", messageID, prompt: { text } }),
    context: (init: { system?: any[]; messages?: any[] }) => {
      const event: any = {
        sessionID: "session",
        model: { providerID: "fixture", id: "fixture" },
        system: init.system ?? [],
      };
      if (init.messages !== undefined) event.messages = init.messages;
      return hooks.get("context")!(event).then(() => event);
    },
  };
}

describe("v2 memory tail placement", () => {
  it("places the complete memory payload at the conversation tail, not the system prefix", async () => {
    const payload = "<memory_context>tail knowledge</memory_context>";
    const runtime = await host({ load: async () => payload });
    try {
      await runtime.prompt("msg-1", "authored query");
      const systemSentinel = [{ type: "text", text: "fixed prefix" }];
      const history = [Message.user("authored query")];
      const event = await runtime.context({ system: systemSentinel, messages: history });
      expect(event.system).toEqual(systemSentinel);
      expect(event.system).toHaveLength(1);
      expect(Array.isArray(event.messages)).toBe(true);
      expect(event.messages).toHaveLength(history.length + 1);
      // Canonical history is not mutated: a fresh array carries the tail.
      expect(event.messages).not.toBe(history);
      expect(history).toHaveLength(1);
      const tail = event.messages[event.messages.length - 1];
      expect(tail).toBeInstanceOf(Message);
      expect(tail.role).toBe("user");
      expect(textOf(tail)).toBe(payload);
      // Shared cross-plugin brand survives construction.
      expect((tail as any)[BRAND]).toBe("memory");
    } finally {
      await runtime.cleanup();
    }
  });

  it("brands the shared tail without serializing the marker", async () => {
    const runtime = await host({ load: async () => "branded payload" });
    try {
      await runtime.prompt("msg-1", "query");
      const event = await runtime.context({ system: [], messages: [Message.user("query")] });
      const tail = event.messages[event.messages.length - 1];
      expect((tail as any)[BRAND]).toBe("memory");
      const descriptor = Object.getOwnPropertyDescriptor(tail, BRAND);
      expect(descriptor?.enumerable).toBe(false);
      expect(Object.keys(tail)).not.toContain(String(BRAND));
      expect(JSON.stringify(tail)).not.toContain("transient-context");
      expect(JSON.stringify(tail)).toContain("branded payload");
    } finally {
      await runtime.cleanup();
    }
  });

  it("repeated construction does not accumulate copies and keeps real user text", async () => {
    const payload = "same text";
    const runtime = await host({ load: async () => payload });
    try {
      await runtime.prompt("msg-1", "query");
      const owned = [Message.user("query"), Message.user(payload)];
      const first = await runtime.context({ system: [], messages: owned });
      expect(first.messages).toHaveLength(3);
      // The real user message whose text resembles memory context survives.
      expect(first.messages[1]).toBe(owned[1]);
      expect(textOf(first.messages[1])).toBe(payload);
      expect(textOf(first.messages[2])).toBe(payload);
      expect((first.messages[2] as any)[BRAND]).toBe("memory");
      // A host that carries the previous tail forward still ends with one copy.
      const second = await runtime.context({ system: [], messages: first.messages });
      const branded = second.messages.filter((m: any) => (m as any)[BRAND] === "memory");
      expect(branded).toHaveLength(1);
      expect(second.messages).toHaveLength(3);
      expect(second.messages[1]).toBe(owned[1]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("leaves another plugin's branded tail and tool adjacency intact", async () => {
    const runtime = await host({ load: async () => "memory payload" });
    try {
      await runtime.prompt("msg-1", "query");
      const other = Message.user("other plugin tail");
      Object.defineProperty(other, BRAND, {
        value: "other",
        enumerable: false,
        writable: false,
        configurable: true,
      });
      const toolCall = Message.make({
        role: "assistant",
        content: [
          { type: "tool-call", id: "call-1", name: "memory", input: { mode: "search" } } as any,
        ],
      });
      const toolResult = Message.make({
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "memory",
            result: { type: "text", value: "ok" },
          } as any,
        ],
      });
      const history = [Message.user("query"), toolCall, toolResult, other];
      const event = await runtime.context({ system: [], messages: history });
      // Existing pair order is preserved; both tails remain at the end.
      expect(event.messages.slice(0, 4)).toEqual([history[0], toolCall, toolResult, other]);
      expect(event.messages).toHaveLength(5);
      expect((event.messages[3] as any)[BRAND]).toBe("other");
      expect((event.messages[4] as any)[BRAND]).toBe("memory");
    } finally {
      await runtime.cleanup();
    }
  });

  it("suppression removes a stale tail without touching system or real history", async () => {
    let allow = true;
    const runtime = await host({
      load: async () => "stale payload",
      capture: async () => allow,
    });
    try {
      await runtime.prompt("msg-1", "query");
      const history = [Message.user("query")];
      const injected = await runtime.context({ system: [], messages: history });
      expect(injected.messages).toHaveLength(2);
      allow = false;
      await runtime.prompt("msg-2", "<system-reminder>injected only</system-reminder>");
      const systemSentinel = [{ type: "text", text: "fixed" }];
      const suppressed = await runtime.context({
        system: systemSentinel,
        messages: injected.messages,
      });
      expect(suppressed.system).toEqual(systemSentinel);
      expect(suppressed.messages.filter((m: any) => (m as any)[BRAND] === "memory")).toHaveLength(
        0
      );
      expect(suppressed.messages).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("hook inputs without injected memory stay unchanged", async () => {
    const runtime = await host({ load: async () => "" });
    try {
      await runtime.prompt("msg-1", "query");
      const system: any[] = [];
      const messages = [Message.user("query")];
      const event = await runtime.context({ system, messages });
      expect(event.system).toBe(system);
      expect(event.messages).toBe(messages);
    } finally {
      await runtime.cleanup();
    }
  });
});

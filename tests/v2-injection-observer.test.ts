import { describe, expect, it } from "bun:test";
import { Message } from "@opencode/ai";
import { registerV2Adapter, type InjectionReporter } from "../src/v2/adapter.js";
import { MAX_INJECTION_SNAPSHOTS, createInjectionObserver } from "../src/v2/injection-observer.js";
import type { InjectionAttachment } from "../src/v2/injection-rpc.js";

function tailTexts(event: any): string[] {
  return ((event.messages ?? []) as any[]).map((message) =>
    Array.isArray(message?.content)
      ? message.content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => part.text ?? "")
          .join("\n")
      : (message?.text ?? "")
  );
}

async function host(options: {
  load: (sessionID: string, query?: string) => Promise<string>;
  enabled?: () => boolean;
  refreshOnPrompt?: boolean;
  capture?: (input: any, output: any) => Promise<boolean>;
  report?: InjectionReporter;
}) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const attachments: InjectionAttachment[] = [];
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
        enabled: options.enabled ?? (() => true),
        refreshOnPrompt: () => options.refreshOnPrompt ?? true,
        capturePrompt: options.capture ?? (async () => true),
        load: options.load,
      },
      "chat.params": async () => {},
    },
    options.report ?? ((attachment) => attachments.push(attachment))
  );
  return {
    cleanup,
    attachments,
    prompt: (sessionID: string, messageID: string, text = messageID) =>
      hooks.get("prompt")!({ sessionID, messageID, prompt: { text } }),
    context: async (sessionID: string, messages: any[] = []) => {
      const event: any = {
        sessionID,
        model: { providerID: "fixture", id: "fixture" },
        system: [],
        messages,
      };
      await hooks.get("context")!(event);
      return event;
    },
  };
}

describe("v2 injection observer", () => {
  it("keeps at most 50 session snapshots by default", () => {
    expect(MAX_INJECTION_SNAPSHOTS).toBe(50);
    const observer = createInjectionObserver();
    for (let index = 0; index <= MAX_INJECTION_SNAPSHOTS; index++) {
      observer.record({ sessionID: `ses-${index}`, status: "injected", text: `text-${index}` });
    }
    expect(observer.latest({ sessionID: "ses-0" })).toBeNull();
    expect(observer.latest({ sessionID: "ses-50" })?.text).toBe("text-50");
  });

  it("refreshing a session protects it from eviction", () => {
    const observer = createInjectionObserver(3);
    observer.record({ sessionID: "a", status: "injected", text: "a" });
    observer.record({ sessionID: "b", status: "injected", text: "b" });
    observer.record({ sessionID: "c", status: "injected", text: "c" });
    observer.record({ sessionID: "a", status: "empty", text: "" });
    observer.record({ sessionID: "d", status: "injected", text: "d" });
    expect(observer.latest({ sessionID: "b" })).toBeNull();
    expect(observer.latest({ sessionID: "a" })?.status).toBe("empty");
    expect(observer.latest({ sessionID: "d" })?.text).toBe("d");
  });

  it("assigns monotonic revisions and timestamps, continuing across clear", () => {
    const observer = createInjectionObserver();
    const first = observer.record({ sessionID: "s", status: "injected", text: "one" });
    const second = observer.record({ sessionID: "s", status: "injected", text: "two" });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.timestamp).toBeGreaterThanOrEqual(first.timestamp);
    expect(observer.latest({ sessionID: "s" })).toEqual(second);
    expect(observer.latest({ sessionID: "missing" })).toBeNull();
    observer.clear();
    expect(observer.latest({ sessionID: "s" })).toBeNull();
    const afterClear = observer.record({ sessionID: "s", status: "empty", text: "" });
    expect(afterClear.revision).toBeGreaterThan(second.revision);
  });

  it("reports the exact injected string once, after legacy model work", async () => {
    const order: string[] = [];
    const hooks = new Map<string, (event: any) => Promise<void>>();
    const attachments: InjectionAttachment[] = [];
    const payload = "<memory_context>exact payload</memory_context>";
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
          enabled: () => true,
          refreshOnPrompt: () => true,
          capturePrompt: async () => true,
          load: async () => payload,
        },
        "chat.params": async () => {
          order.push("chat.params");
        },
      },
      (attachment) => {
        order.push("report");
        attachments.push(attachment);
      }
    );
    try {
      await hooks.get("prompt")!({ sessionID: "s", messageID: "msg-1", prompt: { text: "q" } });
      const event: any = {
        sessionID: "s",
        model: { providerID: "fixture", id: "fixture" },
        system: [],
        messages: [Message.user("q")],
      };
      await hooks.get("context")!(event);
      expect(order).toEqual(["chat.params", "report"]);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        sessionID: "s",
        messageID: "msg-1",
        status: "injected",
        text: payload,
      });
      expect(tailTexts(event).at(-1)).toBe(payload);
    } finally {
      await cleanup();
    }
  });

  it("omits messageID when the context hook runs without a known message", async () => {
    const runtime = await host({ load: async () => "cold payload" });
    try {
      const event = await runtime.context("fresh-session");
      expect(tailTexts(event)).toEqual(["cold payload"]);
      expect(runtime.attachments).toHaveLength(1);
      expect(runtime.attachments[0].status).toBe("injected");
      expect("messageID" in runtime.attachments[0]).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it("replaces a prior payload with an empty observation carrying no text", async () => {
    let current = "first payload";
    const observer = createInjectionObserver();
    const runtime = await host({
      load: async () => current,
      report: (attachment) => {
        observer.record(attachment);
      },
    });
    try {
      await runtime.prompt("s", "msg-1", "query");
      await runtime.context("s", [Message.user("query")]);
      expect(observer.latest({ sessionID: "s" })?.status).toBe("injected");
      current = "";
      await runtime.prompt("s", "msg-2", "next query");
      await runtime.context("s", [Message.user("next query")]);
      expect(observer.latest({ sessionID: "s" })).toMatchObject({
        sessionID: "s",
        messageID: "msg-2",
        status: "empty",
        text: "",
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("replaces a prior payload with a suppressed observation carrying no text", async () => {
    let allow = true;
    const observer = createInjectionObserver();
    const runtime = await host({
      load: async () => "stale payload",
      capture: async () => allow,
      report: (attachment) => {
        observer.record(attachment);
      },
    });
    try {
      await runtime.prompt("s", "msg-1", "query");
      await runtime.context("s", [Message.user("query")]);
      expect(observer.latest({ sessionID: "s" })?.status).toBe("injected");
      allow = false;
      await runtime.prompt("s", "msg-2", "<system-reminder>injected only</system-reminder>");
      const event = await runtime.context("s", [Message.user("query")]);
      expect(tailTexts(event)).toEqual(["query"]);
      expect(observer.latest({ sessionID: "s" })).toMatchObject({
        status: "suppressed",
        text: "",
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("replaces a prior payload with a disabled observation carrying no text", async () => {
    let enabled = true;
    const observer = createInjectionObserver();
    const runtime = await host({
      load: async () => "payload",
      enabled: () => enabled,
      report: (attachment) => {
        observer.record(attachment);
      },
    });
    try {
      await runtime.prompt("s", "msg-1", "query");
      await runtime.context("s", [Message.user("query")]);
      expect(observer.latest({ sessionID: "s" })?.status).toBe("injected");
      enabled = false;
      await runtime.prompt("s", "msg-2", "query");
      const event = await runtime.context("s", [Message.user("query")]);
      expect(tailTexts(event)).toEqual(["query"]);
      expect(observer.latest({ sessionID: "s" })).toMatchObject({
        status: "disabled",
        text: "",
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("tracks sessions separately", async () => {
    const runtime = await host({ load: async (sessionID) => `payload-${sessionID}` });
    try {
      await runtime.prompt("s1", "m1", "q1");
      await runtime.prompt("s2", "m2", "q2");
      await runtime.context("s1", [Message.user("q1")]);
      await runtime.context("s2", [Message.user("q2")]);
      expect(runtime.attachments).toEqual([
        { sessionID: "s1", messageID: "m1", status: "injected", text: "payload-s1" },
        { sessionID: "s2", messageID: "m2", status: "injected", text: "payload-s2" },
      ]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps the tail injection when the injection callback throws", async () => {
    const runtime = await host({
      load: async () => "payload despite failure",
      report: () => {
        throw new Error("observer exploded");
      },
    });
    try {
      await runtime.prompt("s", "msg-1", "query");
      const event = await runtime.context("s", [Message.user("query")]);
      expect(tailTexts(event)).toEqual(["query", "payload despite failure"]);
    } finally {
      await runtime.cleanup();
    }
  });
});

import { describe, expect, it } from "bun:test";
import { Message } from "@opencode/ai";
import { registerV2Adapter } from "../src/v2/adapter.js";

const BRAND = Symbol.for("opencode.transient-context.v1");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((release, deny) => {
    resolve = release;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function textOf(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text ?? "")
    .join("\n");
}

async function flushRestoration() {
  await Promise.resolve();
  await Promise.resolve();
}

async function restorationRuntime(options: {
  load: (sessionID: string, query?: string) => Promise<string>;
  restore?: (sessionID: string) => Promise<string>;
  capture?: (input: any, output: any) => Promise<boolean>;
  cacheKey?: () => string;
  enabled?: () => boolean;
  refreshOnPrompt?: boolean;
}) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const legacyEvents: any[] = [];
  const legacyNotified = deferred<void>();
  let nextEvent: ((event: any) => void) | undefined;
  const cleanup = await registerV2Adapter(
    {
      location: { directory: "/workspace/project" },
      tool: { transform: async () => {} },
      session: {
        hook: async (name: string, callback: (event: any) => Promise<void>) => {
          hooks.set(name, callback);
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          while (!signal.aborted) {
            const event = await new Promise<any>((resolve) => {
              nextEvent = resolve;
              signal.addEventListener("abort", () => resolve(null), { once: true });
            });
            if (!event) return;
            yield event;
          }
        },
      },
    } as any,
    {
      tool: { memory: { description: "memory" } },
      memoryContext: {
        enabled: options.enabled ?? (() => true),
        refreshOnPrompt: () => options.refreshOnPrompt ?? true,
        cacheKey: options.cacheKey,
        capturePrompt: options.capture ?? (async () => true),
        load: options.load,
        ...(options.restore ? { restore: options.restore } : {}),
      },
      event: async (input: any) => {
        legacyEvents.push(input);
        legacyNotified.resolve();
      },
    }
  );
  return {
    cleanup,
    legacyEvents,
    waitForLegacyEvent: () => legacyNotified.promise,
    prompt: (messageID: string, text = messageID, sessionID = "session") =>
      hooks.get("prompt")!({ sessionID, messageID, prompt: { text } }),
    contextEvent: (init: { system?: any[]; messages?: any[]; options?: any }) => {
      const event: any = {
        sessionID: "session",
        model: { providerID: "fixture", id: "fixture" },
        system: init.system ?? [],
      };
      if (init.messages !== undefined) event.messages = init.messages;
      if (init.options !== undefined) event.options = init.options;
      return hooks.get("context")!(event).then(() => event);
    },
    emitCompacted: async (sessionID = "session") => {
      // Wait until the watcher is listening; each tick is a real promise turn.
      for (let attempt = 0; attempt < 100 && !nextEvent; attempt++) {
        await Promise.resolve();
      }
      if (!nextEvent) throw new Error("event subscriber not ready");
      nextEvent({
        type: "session.compaction.ended",
        location: { directory: "/workspace/project" },
        data: { sessionID },
      });
    },
  };
}

describe("v2 durable compaction restoration", () => {
  it("restores durable context through the branded tail without legacy side effects", async () => {
    let loads = 0;
    const restoreStarted = deferred<void>();
    const restoreGate = deferred<string>();
    const restoreCalls: string[] = [];
    const runtime = await restorationRuntime({
      cacheKey: () => "stable-key",
      load: async () => {
        loads++;
        return "original knowledge";
      },
      restore: async (sessionID: string) => {
        restoreCalls.push(sessionID);
        restoreStarted.resolve();
        return restoreGate.promise;
      },
    });
    try {
      await runtime.prompt("msg-1", "authored query");
      const seeded = await runtime.contextEvent({
        system: [],
        messages: [Message.user("authored query")],
      });
      expect(textOf(seeded.messages[seeded.messages.length - 1])).toBe("original knowledge");
      expect(loads).toBe(1);

      await runtime.emitCompacted();
      await restoreStarted.promise;
      // The old cached context is gone while the owned restoration is pending.
      expect(loads).toBe(1);
      restoreGate.resolve("restored knowledge");
      await restoreGate.promise;
      await flushRestoration();

      const system = [{ type: "text", text: "fixed prefix" }];
      const history = [Message.user("authored query")];
      const options = { cacheKey: "distinctive-123", flag: true };
      const event = await runtime.contextEvent({ system, messages: history, options });

      expect(restoreCalls).toEqual(["session"]);
      expect(loads).toBe(1);
      expect(runtime.legacyEvents).toEqual([]);
      expect(event.system).toBe(system);
      expect(event.options).toBe(options);
      expect(event.options).toEqual({ cacheKey: "distinctive-123", flag: true });
      expect(history).toHaveLength(1);
      expect(event.messages).not.toBe(history);
      expect(event.messages).toHaveLength(2);
      expect(event.messages[0]).toBe(history[0]);
      const tail = event.messages[event.messages.length - 1];
      expect(tail).toBeInstanceOf(Message);
      expect(tail.role).toBe("user");
      expect(textOf(tail)).toBe("restored knowledge");
      expect((tail as any)[BRAND]).toBe("memory");
    } finally {
      await runtime.cleanup();
    }
  });

  it("supersedes a deferred restoration when an authored prompt lands first", async () => {
    let loads = 0;
    const restoreStarted = deferred<void>();
    const restoreGate = deferred<string>();
    const seenQueries: Array<string | undefined> = [];
    const runtime = await restorationRuntime({
      cacheKey: () => "stable-key",
      load: async (_sessionID: string, query?: string) => {
        loads++;
        seenQueries.push(query);
        return query === "second query" ? "new context" : "original context";
      },
      restore: async () => {
        restoreStarted.resolve();
        return restoreGate.promise;
      },
    });
    try {
      await runtime.prompt("msg-1", "first query");
      expect(loads).toBe(1);

      await runtime.emitCompacted();
      await restoreStarted.promise;

      // A context hook during the pending restoration must not start a competing load.
      const pendingEvent = await runtime.contextEvent({ system: [], messages: [] });
      expect(pendingEvent.messages).toEqual([]);
      expect(loads).toBe(1);

      await runtime.prompt("msg-2", "second query");
      expect(loads).toBe(2);
      expect(seenQueries).toEqual(["first query", "second query"]);

      restoreGate.resolve("stale restored");
      await restoreGate.promise;
      await flushRestoration();
      await flushRestoration();

      const event = await runtime.contextEvent({
        system: [],
        messages: [Message.user("second query")],
      });
      expect(textOf(event.messages[event.messages.length - 1])).toBe("new context");
      expect(loads).toBe(2);
      expect(runtime.legacyEvents).toEqual([]);

      const again = await runtime.contextEvent({
        system: [],
        messages: [Message.user("second query")],
      });
      expect(textOf(again.messages[again.messages.length - 1])).toBe("new context");
    } finally {
      await runtime.cleanup();
    }
  });

  it("forwards compaction to legacy handlers when no restore hook exists", async () => {
    let current = "cached-1";
    const runtime = await restorationRuntime({
      refreshOnPrompt: false,
      load: async () => current,
    });
    try {
      await runtime.prompt("msg-1", "query");
      expect(
        textOf((await runtime.contextEvent({ system: [], messages: [] })).messages.slice(-1)[0])
      ).toBe("cached-1");

      current = "cached-2";
      await runtime.emitCompacted();
      await runtime.waitForLegacyEvent();
      expect(runtime.legacyEvents).toEqual([
        { event: { type: "session.compacted", properties: { sessionID: "session" } } },
      ]);

      const event = await runtime.contextEvent({ system: [], messages: [] });
      expect(textOf(event.messages[event.messages.length - 1])).toBe("cached-2");
    } finally {
      await runtime.cleanup();
    }
  });
});

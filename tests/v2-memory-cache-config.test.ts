import { describe, expect, it } from "bun:test";
import { registerV2Adapter } from "../src/v2/adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function host(load: (sessionID: string, query?: string) => Promise<string>) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const settings = { key: "initial", enabled: true };
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
        enabled: () => settings.enabled,
        refreshOnPrompt: () => false,
        cacheKey: () => JSON.stringify(settings),
        capturePrompt: async () => true,
        load,
      },
    }
  );
  return {
    settings,
    cleanup,
    prompt: (messageID: string) =>
      hooks.get("prompt")!({ sessionID: "session", messageID, prompt: { text: messageID } }),
    context: async () => {
      const event: any = {
        sessionID: "session",
        model: {},
        system: [] as Array<{ type: string; text: string }>,
        messages: [] as any[],
      };
      await hooks.get("context")!(event);
      // The fixed system prefix never carries memory; the tail does.
      expect(event.system).toEqual([]);
      return (event.messages as any[]).map((message) =>
        Array.isArray(message?.content)
          ? message.content
              .filter((part: any) => part?.type === "text")
              .map((part: any) => part.text)
              .join("\n")
          : message?.text
      );
    },
  };
}

describe("V2 memory cache configuration", () => {
  it("keeps first-query context until configuration changes between model calls", async () => {
    let current = "first";
    const runtime = await host(async () => current);
    try {
      await runtime.prompt("one");
      current = "new policy";
      await runtime.prompt("two");
      expect(await runtime.context()).toEqual(["first"]);
      runtime.settings.key = "smaller budget and stricter threshold";
      expect(await runtime.context()).toEqual(["new policy"]);
      runtime.settings.enabled = false;
      expect(await runtime.context()).toEqual([]);
      current = "enabled again";
      runtime.settings.enabled = true;
      expect(await runtime.context()).toEqual(["enabled again"]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("does not cache a prompt load that finishes after its configuration changed", async () => {
    const old = deferred<string>();
    const started = deferred<void>();
    let loads = 0;
    const runtime = await host(async () => {
      if (loads++ === 0) {
        started.resolve();
        return old.promise;
      }
      return "current policy";
    });
    try {
      const prompt = runtime.prompt("one");
      await started.promise;
      runtime.settings.key = "new";
      old.resolve("stale policy");
      await prompt;
      expect(await runtime.context()).toEqual(["current policy"]);
      expect(await runtime.context()).toEqual(["current policy"]);
    } finally {
      await runtime.cleanup();
    }
  });

  it("does not inject an old cold reload result after a config change", async () => {
    const old = deferred<string>();
    const started = deferred<void>();
    let loads = 0;
    const runtime = await host(async () => {
      if (loads++ === 0) {
        started.resolve();
        return old.promise;
      }
      return "fresh reload";
    });
    try {
      const cold = runtime.context();
      await started.promise;
      runtime.settings.key = "new";
      old.resolve("stale reload");
      expect(await cold).toEqual([]);
      expect(await runtime.context()).toEqual(["fresh reload"]);
    } finally {
      await runtime.cleanup();
    }
  });
});

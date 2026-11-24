import { describe, expect, test } from "bun:test";
import { rerankWithJev } from "../src/services/jev.js";
import { JEV_ENDPOINT, JEV_MODEL, type JevRerankOptions } from "../src/services/jev-types.js";
import type { SearchResult } from "../src/services/turso/types.js";

const key = "test-secret-123456";
const options: JevRerankOptions = { enabled: true, apiKey: key, timeoutMs: 1000, maxCandidates: 8 };
const candidate = (id: string, memory = `memory ${id}`): SearchResult => ({
  id,
  memory,
  similarity: 0.71,
  scoreComponents: { content: 0.2, tags: 0.3, keyword: 0.4 },
  projectPath: `/private/${id}`,
  tags: ["private-tag"],
  sessionId: `session-${id}`,
});
const answer = (choice: "relevant" | "irrelevant" | "unknown", confidence = 0.8) => ({
  type: "choice",
  choice,
  confidence,
  probabilities:
    choice === "relevant"
      ? { relevant: 0.87, irrelevant: 0.12, unknown: 0.01 }
      : choice === "irrelevant"
        ? { relevant: 0.03, irrelevant: 0.95, unknown: 0.02 }
        : { relevant: 0.2, irrelevant: 0.2, unknown: 0.6 },
});
const response = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: JEV_MODEL, answers, ...extra }), { status: 200 });
const fakeFetch = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>
): typeof fetch => (async (input, init) => handler(input, init)) as typeof fetch;

describe("rerankWithJev", () => {
  test("promotes relevant evidence without sorting by class certainty, omits only confident complete irrelevant evidence, and preserves the tail and metadata", async () => {
    const baseline = [
      candidate("first"),
      candidate("discard"),
      candidate("uncertain"),
      candidate("long", "x".repeat(2001)),
      candidate("last"),
      candidate("tail"),
    ];
    const results = await rerankWithJev("history", baseline, {
      ...options,
      maxCandidates: 5,
      fetch: fakeFetch(() =>
        response({
          m0: answer("relevant", 0.8),
          m1: answer("irrelevant"),
          m2: answer("unknown"),
          m3: answer("irrelevant"),
          m4: {
            ...answer("relevant"),
            probabilities: { relevant: 0.91, irrelevant: 0.08, unknown: 0.01 },
          },
        })
      ),
    });
    expect(results.status).toBe("reranked");
    expect(results.assessed).toBe(5);
    expect(results.abstained).toBe(1);
    expect(results.results.map((item) => item.id)).toEqual([
      "first",
      "last",
      "uncertain",
      "long",
      "tail",
    ]);
    expect(results.results[0]).toEqual({
      ...baseline[0],
      jev: {
        model: JEV_MODEL,
        choice: "relevant",
        confidence: 0.8,
        probabilities: { relevant: 0.87, irrelevant: 0.12, unknown: 0.01 },
      },
    });
    expect(results.results[4]).toBe(baseline[5]);
  });

  test("sends only redacted text and generated IDs, with pinned authenticated no-redirect transport", async () => {
    const original = candidate("sensitive-id", `public <private>hide-this</private> ${key}`);
    let capturedUrl: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const result = await rerankWithJev(`query <private>hide-query</private> ${key}`, [original], {
      ...options,
      apiKey: ` ${key}\n`,
      fetch: fakeFetch((url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return response({ m0: answer("unknown") });
      }),
    });
    expect(capturedUrl).toBe(JEV_ENDPOINT);
    expect(capturedInit?.redirect).toBe("error");
    expect(capturedInit?.headers).toEqual({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    });
    const raw = String(capturedInit?.body);
    expect(raw).not.toContain(key);
    expect(raw).not.toContain("hide-this");
    expect(raw).not.toContain("hide-query");
    expect(raw).not.toContain("sensitive-id");
    expect(raw).not.toContain("private-tag");
    expect(raw).not.toContain("/private/");
    expect(raw).not.toContain("session-");
    const body = JSON.parse(raw);
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state).toEqual({
      query: "query [REDACTED] [REDACTED]",
      candidates: { m0: "public [REDACTED] [REDACTED]" },
    });
    expect(Object.keys(body.questions)).toEqual(["m0"]);
    expect(result.status).toBe("reranked");
  });

  test("returns the original baseline on invalid, incomplete, echoed, and transport responses", async () => {
    const baseline = [candidate("a"), candidate("b")];
    const responses = [
      response({ m0: answer("relevant") }),
      response({
        m0: answer("relevant"),
        m1: {
          ...answer("irrelevant"),
          probabilities: { relevant: 0.9, irrelevant: 0.05, unknown: 0.05 },
        },
      }),
      response({ m0: answer("relevant"), m1: answer("unknown") }, { echo: key }),
      response({ m0: answer("relevant"), m1: answer("unknown"), extra: answer("unknown") }),
      new Response("private remote error", { status: 500 }),
    ];
    for (const remote of responses) {
      const result = await rerankWithJev("query", baseline, {
        ...options,
        fetch: fakeFetch(() => remote),
      });
      expect(result.status).toBe("fallback");
      expect(result.results).toEqual(baseline);
      expect(result.assessed).toBe(0);
      expect(result.abstained).toBe(0);
      expect(JSON.stringify(result)).not.toContain("private remote error");
    }
    const failed = await rerankWithJev("query", baseline, {
      ...options,
      fetch: fakeFetch(() => {
        throw new Error(key);
      }),
    });
    expect(failed.results).toEqual(baseline);
    expect(failed.reason).toBe("request-failed");
    expect(JSON.stringify(failed)).not.toContain(key);
  });

  test("enforces request and streamed response limits and leaves the unassessed tail intact", async () => {
    const many = Array.from({ length: 25 }, (_, i) => candidate(String(i), "x"));
    let requestCount = 0;
    const result = await rerankWithJev("q", many, {
      ...options,
      maxCandidates: 100,
      fetch: fakeFetch((_url, init) => {
        requestCount++;
        const body = JSON.parse(String(init?.body));
        expect(Object.keys(body.state.candidates)).toHaveLength(24);
        return response(
          Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`m${i}`, answer("irrelevant")]))
        );
      }),
    });
    expect(requestCount).toBe(1);
    expect(result.assessed).toBe(24);
    expect(result.abstained).toBe(24);
    expect(result.results).toEqual([many[24]]);
    const huge = Array.from({ length: 24 }, (_, i) => candidate(String(i), "😀".repeat(1000)));
    const limited = await rerankWithJev("q", huge, {
      ...options,
      maxCandidates: 24,
      fetch: fakeFetch(() => {
        throw new Error("must not send");
      }),
    });
    expect(limited.reason).toBe("input-limit");
    expect(limited.results).toEqual(huge);
    const oversized = await rerankWithJev("q", [many[0]!], {
      ...options,
      fetch: fakeFetch(() => new Response("x".repeat(128 * 1024 + 1))),
    });
    expect(oversized.reason).toBe("invalid-response");
    expect(oversized.results).toEqual([many[0]]);
  });

  test("truncates query and protects evidence against exclusion when the query is incomplete", async () => {
    const baseline = [candidate("a")];
    const result = await rerankWithJev("q".repeat(8001), baseline, {
      ...options,
      fetch: fakeFetch((_url, init) => {
        const query = JSON.parse(String(init?.body)).state.query;
        expect(query.length).toBe(8000);
        expect(query.endsWith("[TRUNCATED]")).toBe(true);
        return response({ m0: answer("irrelevant") });
      }),
    });
    expect(result.status).toBe("reranked");
    expect(result.abstained).toBe(0);
    expect(result.results.map((item) => item.id)).toEqual(["a"]);
  });

  test("does not contact the service when disabled, missing a key, or given empty input, and respects an aborted caller", async () => {
    const baseline = [candidate("a")];
    const fetch = fakeFetch(() => {
      throw new Error("must not send");
    });
    expect((await rerankWithJev("q", baseline, { ...options, enabled: false, fetch })).status).toBe(
      "disabled"
    );
    expect((await rerankWithJev("q", baseline, { ...options, apiKey: "", fetch })).reason).toBe(
      "missing-key"
    );
    expect((await rerankWithJev(" ", baseline, { ...options, fetch })).results).toEqual(baseline);
    const controller = new AbortController();
    controller.abort();
    const aborted = await rerankWithJev("q", baseline, {
      ...options,
      fetch,
      signal: controller.signal,
    });
    expect(aborted.reason).toBe("request-failed");
    expect(aborted.results).toEqual(baseline);
  });

  test("times out even when the transport ignores its abort signal", async () => {
    const baseline = [candidate("a")];
    const result = await rerankWithJev("q", baseline, {
      ...options,
      timeoutMs: 10,
      fetch: fakeFetch(() => new Promise<Response>(() => {})),
    });
    expect(result.reason).toBe("request-failed");
    expect(result.results).toEqual(baseline);
  });
});

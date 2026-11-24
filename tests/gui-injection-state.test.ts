import { describe, expect, it } from "bun:test";
import { createInjectionState, type InjectionStateView } from "../src/gui/injection-state.js";
import type { InjectionObservation } from "../src/v2/injection-rpc.js";

function snapshot(text: string, revision: number): InjectionObservation {
  return {
    sessionID: "ses-1",
    messageID: "msg-1",
    revision,
    timestamp: 1000 + revision,
    status: "injected",
    text,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((done) => setTimeout(done, 0));

function harness() {
  const views: InjectionStateView[] = [];
  const fetches: Array<ReturnType<typeof deferred<InjectionObservation | null>>> = [];
  const listeners = new Set<() => void>();
  let subscribes = 0;
  let unsubscribes = 0;
  const state = createInjectionState(
    {
      fetchLatest: (_signal) => {
        const next = deferred<InjectionObservation | null>();
        fetches.push(next);
        return next.promise;
      },
      subscribe: (onChanged) => {
        subscribes += 1;
        listeners.add(onChanged);
        return () => {
          unsubscribes += 1;
          listeners.delete(onChanged);
        };
      },
    },
    (view) => views.push(view)
  );
  const latest = () => views[views.length - 1];
  const emitChanged = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    state,
    views,
    latest,
    fetches,
    emitChanged,
    counts: () => ({ subscribes, unsubscribes }),
  };
}

describe("gui injection state", () => {
  it("resolves the initial fetch to the exact snapshot", async () => {
    const h = harness();
    expect(h.latest()).toEqual({ status: "loading", snapshot: null, error: null });
    expect(h.counts().subscribes).toBe(1);

    const first = snapshot("first attachment", 3);
    h.fetches[0].resolve(first);
    await tick();

    expect(h.latest()).toEqual({ status: "ready", snapshot: first, error: null });
  });

  it("drops a stale fetch that resolves after a newer generation", async () => {
    const h = harness();
    h.fetches[0].resolve(snapshot("initial attachment", 1));
    await tick();
    expect(h.latest().snapshot?.text).toBe("initial attachment");

    // A changed event starts a second fetch; the first fetch is already done,
    // so simulate overlap with two in-flight fetches on a fresh harness.
    const overlapping = harness();
    overlapping.emitChanged();
    expect(overlapping.fetches.length).toBe(2);

    const stale = snapshot("stale attachment", 5);
    const fresh = snapshot("fresh attachment", 6);
    overlapping.fetches[1].resolve(fresh);
    await tick();
    expect(overlapping.latest()).toEqual({ status: "ready", snapshot: fresh, error: null });

    overlapping.fetches[0].resolve(stale);
    await tick();
    expect(overlapping.latest().snapshot).toEqual(fresh);
    expect(overlapping.latest().status).toBe("ready");
    overlapping.state.dispose();
  });

  it("reports failure and refetches on retry", async () => {
    const h = harness();
    const failure = new Error("server unreachable");
    h.fetches[0].reject(failure);
    await tick();

    expect(h.latest()).toEqual({ status: "error", snapshot: null, error: failure });

    h.state.retry();
    expect(h.fetches.length).toBe(2);
    expect(h.latest()).toEqual({ status: "loading", snapshot: null, error: null });

    const recovered = snapshot("recovered attachment", 7);
    h.fetches[1].resolve(recovered);
    await tick();
    expect(h.latest()).toEqual({ status: "ready", snapshot: recovered, error: null });
    h.state.dispose();
  });

  it("unsubscribes on dispose and ignores late replies", async () => {
    const h = harness();
    h.state.dispose();
    expect(h.counts().unsubscribes).toBe(1);

    const viewCount = h.views.length;
    h.emitChanged();
    h.fetches[0].resolve(snapshot("late attachment", 9));
    h.state.retry();
    await tick();

    expect(h.fetches.length).toBe(1);
    expect(h.views.length).toBe(viewCount);
  });

  it("turns a synchronous fetch throw into the error state without losing the subscription", async () => {
    const views: InjectionStateView[] = [];
    const listeners = new Set<() => void>();
    let calls = 0;
    const state = createInjectionState(
      {
        fetchLatest: (_signal) => {
          calls += 1;
          if (calls === 1) throw new Error("client gone");
          const next = deferred<InjectionObservation | null>();
          queueMicrotask(() => next.resolve(snapshot("recovered attachment", 11)));
          return next.promise;
        },
        subscribe: (onChanged) => {
          listeners.add(onChanged);
          return () => {
            listeners.delete(onChanged);
          };
        },
      },
      (view) => views.push(view)
    );

    expect(views[views.length - 1].status).toBe("error");
    expect(views[views.length - 1].error).toEqual(new Error("client gone"));
    expect(listeners.size).toBe(1);

    state.retry();
    await tick();
    await tick();
    expect(views[views.length - 1]).toEqual({
      status: "ready",
      snapshot: snapshot("recovered attachment", 11),
      error: null,
    });
    state.dispose();
    expect(listeners.size).toBe(0);
  });
});

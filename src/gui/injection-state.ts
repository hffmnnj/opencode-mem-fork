import type { InjectionObservation } from "../v2/injection-rpc.js";

export type InjectionLoadStatus = "loading" | "ready" | "error";

export interface InjectionStateView {
  status: InjectionLoadStatus;
  snapshot: InjectionObservation | null;
  error: unknown;
}

export interface InjectionStateSource {
  fetchLatest(signal: AbortSignal): Promise<InjectionObservation | null>;
  subscribe(onChanged: () => void): () => void;
}

export interface InjectionState {
  retry(): void;
  dispose(): void;
}

/**
 * Event-driven fetch lifecycle for one session's latest injection snapshot.
 *
 * Subscribes before the initial fetch so no `changed` event slips between
 * them. Every fetch runs under a generation counter: a `changed` event or a
 * retry starts a new generation, and late replies from older generations are
 * dropped instead of overwriting newer content. The last good snapshot stays
 * visible across refetches and failures; callers map it to loading, empty,
 * error, and disconnected UI.
 */
export function createInjectionState(
  source: InjectionStateSource,
  notify: (view: InjectionStateView) => void
): InjectionState {
  let generation = 0;
  let disposed = false;
  let snapshot: InjectionObservation | null = null;
  let status: InjectionLoadStatus = "loading";
  let error: unknown = null;
  let controller: AbortController | null = null;

  const emit = () => {
    if (!disposed) notify({ status, snapshot, error });
  };

  const fetch = () => {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    status = "loading";
    error = null;
    emit();
    let pending: Promise<InjectionObservation | null>;
    try {
      pending = source.fetchLatest(signal);
    } catch (failure) {
      if (disposed || current !== generation || signal.aborted) return;
      status = "error";
      error = failure;
      emit();
      return;
    }
    void pending.then(
      (next) => {
        if (disposed || current !== generation || signal.aborted) return;
        snapshot = next;
        status = "ready";
        error = null;
        emit();
      },
      (failure) => {
        if (disposed || current !== generation || signal.aborted) return;
        status = "error";
        error = failure;
        emit();
      }
    );
  };

  const unsubscribe = source.subscribe(() => {
    if (!disposed) fetch();
  });
  fetch();

  return {
    retry: () => {
      if (!disposed) fetch();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      controller?.abort();
      unsubscribe();
    },
  };
}

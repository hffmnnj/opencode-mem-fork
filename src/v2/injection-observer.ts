import type { InjectionAttachment, InjectionObservation } from "./injection-rpc.js";

/** Latest per-session injection snapshots kept in memory; no disk state. */
export const MAX_INJECTION_SNAPSHOTS = 50;

export interface InjectionObserver {
  record(attachment: InjectionAttachment): InjectionObservation;
  latest(input: { sessionID: string }): InjectionObservation | null;
  clear(): void;
}

export function createInjectionObserver(
  maxSessions: number = MAX_INJECTION_SNAPSHOTS
): InjectionObserver {
  const snapshots = new Map<string, InjectionObservation>();
  let revision = 0;
  return {
    record(attachment: InjectionAttachment): InjectionObservation {
      revision += 1;
      const observation: InjectionObservation = {
        sessionID: attachment.sessionID,
        ...(attachment.messageID === undefined ? {} : { messageID: attachment.messageID }),
        revision,
        timestamp: Date.now(),
        status: attachment.status,
        text: attachment.text,
      };
      // Refresh eviction order so the most recently observed session survives.
      snapshots.delete(attachment.sessionID);
      snapshots.set(attachment.sessionID, observation);
      while (snapshots.size > maxSessions) {
        const oldest = snapshots.keys().next();
        if (oldest.done) break;
        snapshots.delete(oldest.value);
      }
      return observation;
    },
    latest(input: { sessionID: string }): InjectionObservation | null {
      return snapshots.get(input.sessionID) ?? null;
    },
    clear(): void {
      snapshots.clear();
    },
  };
}

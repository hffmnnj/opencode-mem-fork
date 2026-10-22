import { Message } from "@opencode/ai";

const TRANSIENT_CONTEXT = Symbol.for("opencode.transient-context.v1");
export const TRANSIENT_MEMORY_VALUE = "memory";

/** True only for this plugin's own transient memory tail message. */
export function isMemoryTailMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as Record<symbol, unknown>)[TRANSIENT_CONTEXT] === TRANSIENT_MEMORY_VALUE
  );
}

/** Brand a native message as this plugin's transient memory tail. */
export function brandMemoryTailMessage<T extends object>(message: T): T {
  Object.defineProperty(message, TRANSIENT_CONTEXT, {
    value: TRANSIENT_MEMORY_VALUE,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return message;
}

/** Create the transient native user tail carrying the complete memory payload. */
export function createMemoryTailMessage(text: string): Message {
  return brandMemoryTailMessage(Message.user(text));
}

/** Strip only this plugin's branded tails; leave all other messages intact. */
export function withoutMemoryTailMessages<T>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isMemoryTailMessage(message));
}

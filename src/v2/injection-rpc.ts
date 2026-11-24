import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

export const InjectionObservation = z.object({
  sessionID: z.string(),
  messageID: z.string().optional(),
  revision: z.number().int().nonnegative(),
  timestamp: z.number(),
  status: z.enum(["injected", "empty", "suppressed", "disabled"]),
  text: z.string(),
});

export type InjectionObservation = z.infer<typeof InjectionObservation>;
export type InjectionAttachment = Omit<InjectionObservation, "revision" | "timestamp">;

export const MemoryInjections = Rpc.define({
  id: "opencode-mem.injections",
  methods: {
    latest: {
      input: z.object({ sessionID: z.string().min(1) }),
      output: InjectionObservation.nullable(),
    },
  },
  events: {
    changed: {
      schema: z.object({ sessionID: z.string(), revision: z.number().int().nonnegative() }),
    },
  },
});

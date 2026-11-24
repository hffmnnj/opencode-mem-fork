import { describe, expect, it } from "bun:test";
import {
  buildBoundedSummaryPrompt,
  buildMarkdownContext,
  getAutoCaptureMarkdownBudget,
} from "../src/services/auto-capture.js";
import { utf8ByteLength } from "../src/utils/context-limit.js";
import type { CaptureSource } from "../src/services/memory-quality.js";

const user = (text: string): CaptureSource => ({ messageId: "u-1", role: "user", text });
const assistant = (messageId: string, text: string): CaptureSource => ({
  messageId,
  role: "assistant",
  text,
});

describe("capture evidence context budgeting", () => {
  it("includes source IDs and roles with the original text", () => {
    const context = buildMarkdownContext([
      user("Fix the bug"),
      assistant("a-1", "The handler rejects invalid tokens."),
    ]);
    expect(context).toContain('user messageId="u-1"');
    expect(context).toContain('assistant messageId="a-1"');
    expect(context).toContain("Fix the bug");
    expect(context).toContain("The handler rejects invalid tokens.");
  });

  it("bounds UTF-8 size while retaining the prompt and preferring newer responses", () => {
    const context = buildMarkdownContext(
      [
        user("请求"),
        assistant("old", "OLD-" + "旧".repeat(4000)),
        assistant("new", "NEW-" + "新".repeat(4000)),
      ],
      3000
    );
    expect(utf8ByteLength(context)).toBeLessThanOrEqual(3000);
    expect(context).toContain("请求");
    expect(context).toContain('assistant messageId="new"');
    expect(context).toContain("NEW-");
    expect(context).not.toContain('assistant messageId="old"');
    expect(context).toContain("truncated to autoCaptureMaxContextBytes");
  });

  it("reserves request space for prompts, schemas, and model output", () => {
    const totalBudget = 131_072;
    const markdownBudget = getAutoCaptureMarkdownBudget(totalBudget);
    const context = buildMarkdownContext(
      [user("request"), assistant("a", "A".repeat(totalBudget))],
      markdownBudget
    );
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const userPrompt = buildBoundedSummaryPrompt(
      context,
      "system instructions",
      schema,
      totalBudget
    );
    expect(markdownBudget).toBeLessThan(totalBudget);
    expect(utf8ByteLength(userPrompt)).toBeLessThan(totalBudget);
    expect(userPrompt).toContain("truncated to autoCaptureMaxContextBytes");
  });
});

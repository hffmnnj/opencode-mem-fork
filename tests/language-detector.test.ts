import { describe, it, expect } from "bun:test";
import {
  detectLanguage,
  detectPromptLanguage,
  getLanguageName,
  resolveAutoCaptureLanguageName,
} from "../src/services/language-detector.js";

describe("detectLanguage", () => {
  it("should detect Chinese as zh", () => {
    expect(detectLanguage("这是一个中文测试")).toBe("zh");
  });

  it("should detect short Chinese as zh (5+ chars)", () => {
    expect(detectLanguage("这是一个中文测试")).toBe("zh");
  });

  it("should detect English as en", () => {
    expect(detectLanguage("This is an English test")).toBe("en");
  });

  it("should fallback to en for empty string", () => {
    expect(detectLanguage("")).toBe("en");
  });

  it("should fallback to en for whitespace only", () => {
    expect(detectLanguage("   ")).toBe("en");
  });

  it("should fallback to en for very short undetectable input", () => {
    expect(detectLanguage("ab")).toBe("en");
  });
});

describe("getLanguageName", () => {
  it("should return Chinese name for zh", () => {
    const name = getLanguageName("zh");
    expect(name.toLowerCase()).toContain("chinese");
  });

  it("should return English name for en", () => {
    const name = getLanguageName("en");
    expect(name.toLowerCase()).toContain("english");
  });

  it("should fallback to English for unknown code", () => {
    expect(getLanguageName("xyz")).toBe("English");
  });
});

describe("auto-capture prompt language", () => {
  it("detects clear English and Dutch prompt text as two-letter language codes", () => {
    expect(detectPromptLanguage("Please add a regression test for this login bug")).toBe("en");
    expect(
      detectPromptLanguage("Voeg een regressietest toe en herstel de fout in het inloggen.")
    ).toBe("nl");
    expect(
      detectPromptLanguage(
        "Bitte untersuche den Fehler im Login und schreibe einen Test für die Anmeldung."
      )
    ).toBe("de");
  });

  it("abstains when a prompt is short or clearly mixed between languages", () => {
    expect(detectPromptLanguage("Need fix")).toBeNull();
    expect(detectPromptLanguage("Get generate image plugin working ASAP")).toBeNull();
    expect(detectPromptLanguage("Is generate_image working?")).toBeNull();
    expect(detectPromptLanguage("Make sure it works")).toBeNull();
    expect(detectPromptLanguage("Can you fix the bug?")).toBeNull();
    expect(detectPromptLanguage("Please fix the login bug; voeg ook tests toe.")).toBeNull();
  });

  it("ignores fenced and inline code when detecting the language of the user request", () => {
    expect(detectPromptLanguage("```ts\nconst patched = true;\n```")).toBeNull();
    expect(
      detectPromptLanguage(
        "Please fix `loginHandler()`, add a regression test, and document the change clearly."
      )
    ).toBe("en");
  });

  it("keeps explicit language overrides and preserves auto-mode abstention", () => {
    expect(resolveAutoCaptureLanguageName("Voeg tests toe", "fr")).toBe("French");
    expect(
      resolveAutoCaptureLanguageName(
        "Voeg een regressietest toe en herstel de fout in het inloggen.",
        "auto"
      )
    ).toBe("Dutch");
    expect(resolveAutoCaptureLanguageName("Need fix", "auto")).toBeUndefined();
  });
});

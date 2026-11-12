import { franc, francAll } from "franc-min";
import { iso6393, iso6393To1 } from "iso-639-3";

// 3-letter codes without ISO 639-1 equivalents
const FALLBACK_MAP: Record<string, string> = {
  cmn: "zh", // Mandarin Chinese
  yue: "zh", // Cantonese
  arz: "ar", // Egyptian Arabic
  hbs: "sr", // Serbo-Croatian
};

// franc's ranking scores are not calibrated probabilities. Requiring a gap
// between the leading candidates is a conservative heuristic: when languages
// are close, auto-capture abstains instead of letting context or English
// scaffolding choose a language on the user's behalf.
const MIN_LANGUAGE_SCORE_GAP = 0.24;
// Short coding requests can score strongly but incorrectly (for example,
// "Get generate image plugin working ASAP" ranks as Dutch), so require a
// minimum amount of prose before auto-selecting a language.
const MIN_NATURAL_LANGUAGE_LETTERS = 36;
const NON_SPACED_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Detect a language only when the current user prompt provides enough clear
 * natural-language evidence. Code, URLs, and identifiers are excluded, and
 * short or mixed prompts return null rather than defaulting to English.
 */
export function detectPromptLanguage(text: string): string | null {
  if (!text || text.trim().length === 0) return null;

  const prose = text
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+\b/gu, " ")
    .replace(/\b[\p{L}\p{N}_-]+\.[\p{L}\p{N}]{1,8}\b/gu, " ")
    .replace(/\b(?:[\p{Ll}\d]+[\p{Lu}][\p{L}\d]*|[\p{Lu}_]{2,})\b/gu, " ")
    .trim();
  const words = prose.match(/[\p{L}\p{M}]{2,}/gu) ?? [];
  const letters = prose.match(/\p{L}/gu) ?? [];
  const hasEnoughProse =
    (words.length >= 3 && letters.length >= MIN_NATURAL_LANGUAGE_LETTERS) ||
    (NON_SPACED_SCRIPTS.test(prose) && letters.length >= 6);
  if (!hasEnoughProse) return null;

  const ranked = francAll(prose, { minLength: 5 });
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best[0] === "und") return null;
  if (runnerUp && best[1] - runnerUp[1] < MIN_LANGUAGE_SCORE_GAP) return null;

  return iso6393To1[best[0]] || FALLBACK_MAP[best[0]] || null;
}

/**
 * Resolve the auto-capture summary language from an explicit override or the
 * current user's prompt. `undefined` means detection abstained and the system
 * prompt must not force a language.
 */
export function resolveAutoCaptureLanguageName(
  userPrompt: string,
  configuredLanguage?: string
): string | undefined {
  if (configuredLanguage && configuredLanguage !== "auto") {
    return getLanguageName(configuredLanguage);
  }

  const detected = detectPromptLanguage(userPrompt);
  return detected ? getLanguageName(detected) : undefined;
}

export function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) {
    return "en";
  }

  const detected = franc(text, { minLength: 5 });

  if (detected === "und") {
    return "en";
  }

  // Try 2-letter mapping first
  const twoLetter = iso6393To1[detected];
  if (twoLetter) return twoLetter;

  // Fallback for 3-letter codes without 2-letter equivalent
  return FALLBACK_MAP[detected] || "en";
}

export function getLanguageName(code: string): string {
  // Try 2-letter lookup first
  let lang = iso6393.find((l: any) => l.iso6391 === code);
  // Fallback to 3-letter lookup
  if (!lang) {
    lang = iso6393.find((l: any) => l.iso6393 === code);
  }
  return lang?.name || "English";
}

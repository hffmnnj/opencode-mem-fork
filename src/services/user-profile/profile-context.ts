import { userProfileManager } from "./user-profile-manager.js";
import { CONFIG } from "../../config.js";
import type { UserProfileData } from "./types.js";
import { sortProfileItems } from "../../utils/profile.js";
import { log } from "../logger.js";

/**
 * Whole-bullet bound for the injected profile digest. The profile is one
 * section of the bounded memory context, so cap it at a small fraction of the
 * default 12000-character context budget. Bullets that would cross the bound
 * are dropped whole; descriptions are never cut mid-sentence.
 */
const MAX_PROFILE_DIGEST_CHARS = 1200;

/**
 * The profile-analysis prompt asks for confidence in the 0.3-0.5 range for
 * evidence-backed observations. A numerically lower pattern confidence means
 * the entry was weak, unvalidated or decayed, so it is held back from the
 * working-rules digest.
 */
const MIN_PATTERN_CONFIDENCE = 0.3;

/**
 * Legacy patterns written before confidence was stored have no numeric
 * confidence to judge. Keep them only when their frequency shows repeated
 * confirmation; a single observation is not well established.
 */
const MIN_LEGACY_PATTERN_FREQUENCY = 2;

interface DigestSection {
  title: string;
  bullets: string[];
}

function dedupByCategory(items: any[], topN: number): any[] {
  if (topN <= 0) return [];
  if (items.length <= topN) return items;
  const seen = new Set<string>();
  const result: any[] = [];
  for (const item of items) {
    if (seen.has(item.category)) continue;
    seen.add(item.category);
    result.push(item);
    if (result.length >= topN) break;
  }
  return result;
}

function scoreByRecency(items: any[]): any[] {
  const now = Date.now();
  return [...items].sort((a, b) => {
    const ageA = (now - (a.lastSeen || 0)) / (24 * 60 * 60 * 1000);
    const ageB = (now - (b.lastSeen || 0)) / (24 * 60 * 60 * 1000);
    const scoreA = (a.confidence || 0) * 0.7 + Math.exp(-ageA / 90) * 0.3;
    const scoreB = (b.confidence || 0) * 0.7 + Math.exp(-ageB / 90) * 0.3;
    return scoreB - scoreA;
  });
}

function escapeContextText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Return a finite confidence from a number or numeric string, else null. */
function numericConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isPatternEligible(pattern: any): boolean {
  if (pattern?.pendingValidation) return false;

  const confidence = numericConfidence(pattern?.confidence);
  if (confidence !== null) return confidence >= MIN_PATTERN_CONFIDENCE;

  const frequency = Number(pattern?.frequency);
  return Number.isFinite(frequency) && frequency >= MIN_LEGACY_PATTERN_FREQUENCY;
}

function descriptionBullet(item: any, withCategory: boolean): string | null {
  const description = typeof item?.description === "string" ? item.description : "";
  if (description.trim() === "") return null;

  if (!withCategory) {
    return `- ${escapeContextText(description)}`;
  }

  const rawCategory = item?.category;
  const category =
    rawCategory === undefined || rawCategory === null ? "" : String(rawCategory).trim();
  return category
    ? `- [${escapeContextText(category)}] ${escapeContextText(description)}`
    : `- ${escapeContextText(description)}`;
}

function learningPathBullet(path: any): string | null {
  const topic = typeof path?.topic === "string" ? path.topic.trim() : "";
  const description = typeof path?.description === "string" ? path.description : "";

  if (topic === "" && description.trim() === "") return null;
  if (topic === "") return `- ${escapeContextText(description)}`;
  if (description.trim() === "") return `- ${escapeContextText(topic)}`;
  return `- ${escapeContextText(topic)}: ${escapeContextText(description)}`;
}

/**
 * Render the bounded working-rules digest injected into the memory context.
 *
 * Only descriptions, categories and learning-path topics are copied from the
 * stored profile. Frequency counts, evidence quotes and workflow steps are
 * intentionally omitted. Patterns that are pending validation or explicitly
 * low confidence are held back, while established legacy patterns without a
 * numeric confidence survive on frequency alone.
 */
export function buildProfileDigest(profileData: UserProfileData): string | null {
  const injectPrefs = CONFIG.userProfileInjectPreferences ?? 5;
  const injectPats = CONFIG.userProfileInjectPatterns ?? 5;
  const injectWfs = CONFIG.userProfileInjectWorkflows ?? 3;

  const sortedPrefs = Array.isArray(profileData?.preferences)
    ? (sortProfileItems(profileData.preferences as any[], "confidence") as any[])
    : [];
  const sortedPats = Array.isArray(profileData?.patterns)
    ? (sortProfileItems(profileData.patterns as any[], "frequency") as any[])
    : [];
  const sortedWfs = Array.isArray(profileData?.workflows)
    ? (sortProfileItems(profileData.workflows as any[], "frequency") as any[])
    : [];

  const topPrefs = dedupByCategory(
    scoreByRecency(sortedPrefs.slice(0, Math.max(0, injectPrefs) * 2)),
    Math.max(0, injectPrefs)
  );
  // Filter before the category/dedup cap so held-back patterns cannot crowd
  // actionable patterns out of the digest.
  const topPats = dedupByCategory(sortedPats.filter(isPatternEligible), Math.max(0, injectPats));
  const topWfs = sortedWfs.slice(0, Math.max(0, injectWfs));
  const learningPaths = Array.isArray((profileData as any)?.learning_paths)
    ? (profileData as any).learning_paths.slice(0, 3)
    : [];

  const sections: DigestSection[] = [];
  let usedChars = 0;

  const appendSection = (title: string, bullets: Array<string | null>) => {
    const accepted: string[] = [];

    for (const bullet of bullets) {
      if (bullet === null) continue;

      // Each accepted bullet is added whole. A bullet that does not fit in the
      // remaining budget is skipped rather than truncated mid-description.
      const sectionSeparator = accepted.length === 0 && sections.length > 0 ? 2 : 0;
      const bulletSeparator = accepted.length > 0 ? 1 : 0;
      const header = accepted.length === 0 ? title.length + 1 : 0;
      const cost = sectionSeparator + bulletSeparator + header + bullet.length;
      if (usedChars + cost > MAX_PROFILE_DIGEST_CHARS) continue;

      accepted.push(bullet);
      usedChars += cost;
    }

    if (accepted.length > 0) {
      sections.push({ title, bullets: accepted });
    }
  };

  appendSection(
    "User Preferences:",
    topPrefs.map((pref) => descriptionBullet(pref, true))
  );
  appendSection(
    "User Patterns:",
    topPats.map((pattern) => descriptionBullet(pattern, true))
  );
  appendSection(
    "User Workflows:",
    topWfs.map((workflow) => descriptionBullet(workflow, false))
  );
  appendSection(
    "Learning Paths:",
    learningPaths.map((path: any) => learningPathBullet(path))
  );

  if (sections.length === 0) {
    return null;
  }

  return sections.map((section) => `${section.title}\n${section.bullets.join("\n")}`).join("\n\n");
}

export async function getUserProfileContext(userId: string): Promise<string | null> {
  const profile = await userProfileManager.getActiveProfile(userId);

  if (!profile) {
    return null;
  }

  let profileData: UserProfileData;
  try {
    profileData = JSON.parse(profile.profileData);
  } catch (e) {
    // A single corrupt row must not break context injection for everyone.
    log("profile context: failed to parse stored profileData", { error: String(e) });
    return null;
  }

  const text = buildProfileDigest(profileData);

  if (text === null) {
    return null;
  }

  log("profile inject", {
    chars: text.length,
    digest: text.substring(0, 200),
  });

  return text;
}

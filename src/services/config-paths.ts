/**
 * Config file locations shared by the config loader and the config watcher.
 *
 * Kept in its own module so both can depend on it without an import cycle:
 * `config.ts` and `config-watcher.ts` must not import each other, because
 * `config.ts` re-exports the watcher's API and a two-way import breaks
 * module linking (Bun cannot resolve the re-exported binding).
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** Global config directory (`~/.config/opencode`). */
export const CONFIG_DIR = join(homedir(), ".config", "opencode");

/** Global config file candidates; the first existing one wins. */
export const CONFIG_FILES = [
  join(CONFIG_DIR, "opencode-mem.jsonc"),
  join(CONFIG_DIR, "opencode-mem.json"),
];

/** Project-level config paths for an OpenCode setup directory (first existing wins). */
export function getProjectConfigPaths(directory: string): string[] {
  return [
    join(directory, ".opencode", "opencode-mem.jsonc"),
    join(directory, ".opencode", "opencode-mem.json"),
  ];
}

/** Filenames that can change the effective config (global and project share names). */
export const WATCHED_CONFIG_FILENAMES = new Set(["opencode-mem.jsonc", "opencode-mem.json"]);

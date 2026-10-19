/**
 * Config hot reload (fork F4a).
 *
 * Watches the plugin's global and project config files and re-reads the
 * configuration when they change, so editing the config takes effect without
 * restarting OpenCode.
 *
 * This module deliberately owns the wiring between the watcher (which takes
 * its dependencies by injection) and the config loader:
 *
 *  - It must not import `config.ts` AND be imported by `config.ts`, or the
 *    two-way import breaks module linking (Bun cannot resolve the binding).
 *  - It must not add new exports to `config.ts` that plugin setup depends on:
 *    several test fixtures replace `config.js` with a partial stub, and a
 *    missing export there fails the whole plugin at link time.
 *
 * So it lives beside the watcher, imports the config loader one-way, and is
 * imported directly by plugin setup.
 */

import { initConfig } from "../config.js";
import { CONFIG_FILES, getProjectConfigPaths } from "./config-paths.js";
import { startConfigWatcher, stopConfigWatcher } from "./config-watcher.js";
import type { ConfigWatcherStop } from "./config-watcher.js";

export { CONFIG_WATCH_DEBOUNCE_MS } from "./config-watcher.js";
export type { ConfigWatcherStop };

/**
 * Watch this setup directory's config files and re-read the configuration
 * when they change. One watcher per directory; a repeat call returns the
 * existing stop function instead of creating a duplicate watcher.
 */
export function startConfigHotReload(directory: string): ConfigWatcherStop {
  return startConfigWatcher({
    key: directory,
    paths: [...CONFIG_FILES, ...getProjectConfigPaths(directory)],
    onChange: () => initConfig(directory),
  });
}

/** Stop the config watcher for a directory. Returns true when one was active. */
export function stopConfigHotReload(directory: string): boolean {
  return stopConfigWatcher(directory);
}

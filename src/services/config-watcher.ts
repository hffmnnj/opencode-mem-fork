import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { log } from "./logger.js";
import { WATCHED_CONFIG_FILENAMES } from "./config-paths.js";

/** Time to wait after the last fs event before reloading (single saves emit several). */
export const CONFIG_WATCH_DEBOUNCE_MS = 200;

/** Stop function returned by `startConfigWatcher`. Safe to call more than once. */
export type ConfigWatcherStop = () => void;

/**
 * A watched file set plus the action to run when one of them changes.
 *
 * The watcher takes everything it needs by injection and imports no
 * configuration module. `config.ts` cannot import this module either: it
 * re-exports parts of the plugin's public surface, and a two-way import
 * breaks module linking (Bun cannot resolve the re-exported binding).
 */
export interface ConfigWatcherOptions {
  /** Registry key; one watcher per key. */
  key: string;
  /** Absolute paths of the config files to watch. */
  paths: string[];
  /** Called (debounced) after a watched file changes. */
  onChange: () => void;
}

interface ActiveWatcher {
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | undefined;
  stop: ConfigWatcherStop;
}

/** One active watcher per key; a repeat start reuses the existing one. */
const activeWatchers = new Map<string, ActiveWatcher>();

/** Filenames that can change the effective config (global and project share names). */
const WATCHED_FILENAMES = WATCHED_CONFIG_FILENAMES;

/**
 * Watch the plugin's config files and re-run the config reload when they
 * change, so a config edit takes effect without an OpenCode restart.
 *
 * Containing directories are watched (not the files) because editors and
 * tools save via atomic rename, which replaces the file inode and would
 * detach a watch placed on the file itself. Events are filtered by filename,
 * debounced, and coalesced.
 *
 * Never throws: if watching is unsupported or a directory cannot be watched,
 * the failure is logged and the plugin keeps working without hot reload.
 * Idempotent per key: a second call for the same key returns the existing stop
 * function instead of creating a duplicate watcher.
 */
export function startConfigWatcher(options: ConfigWatcherOptions): ConfigWatcherStop {
  const { key, paths, onChange } = options;
  try {
    const existing = activeWatchers.get(key);
    if (existing) {
      return existing.stop;
    }
    if (typeof watch !== "function") {
      log("opencode-mem: config hot reload unavailable (fs.watch not supported)", {
        key,
      });
      return () => {};
    }

    const dirs: string[] = [];
    for (const file of paths) {
      const dir = dirname(file);
      if (!dirs.includes(dir)) {
        dirs.push(dir);
      }
    }

    const entry: ActiveWatcher = { watchers: [], timer: undefined, stop: () => stopEntry() };
    let stopped = false;

    const scheduleReload = (): void => {
      if (stopped) {
        return;
      }
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        try {
          onChange();
          log("opencode-mem: reloaded config after file change", { key });
        } catch (error) {
          // Keep watching so the next valid save recovers. Note that
          // initConfig itself keeps the last-known-good CONFIG when a file
          // is unreadable; only other failures (e.g. unsafe project remote
          // provider fields) reach this catch.
          log("opencode-mem: config reload failed; keeping previous configuration", {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, CONFIG_WATCH_DEBOUNCE_MS);
    };

    const stopEntry = (): void => {
      stopped = true;
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      for (const watcher of entry.watchers) {
        try {
          watcher.close();
        } catch {
          // ignore close failures during teardown
        }
      }
      entry.watchers = [];
      if (activeWatchers.get(key) === entry) {
        activeWatchers.delete(key);
      }
    };

    for (const dir of dirs) {
      try {
        const watcher = watch(dir, (_eventType, filename) => {
          // Some platforms report null instead of a name; reload (debounced)
          // rather than risk missing an atomic-replace save.
          if (typeof filename !== "string" || WATCHED_FILENAMES.has(basename(filename))) {
            scheduleReload();
          }
        });
        watcher.on("error", (error: unknown) => {
          log("opencode-mem: config watcher error", {
            key,
            watchedDir: dir,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        // A config watcher is a background convenience: it must not keep the
        // process alive on its own. Without this, the open handle prevents
        // the host (or a test) from exiting.
        watcher.unref?.();
        entry.watchers.push(watcher);
      } catch (error) {
        // Missing directory (e.g. no project .opencode dir yet), permissions,
        // or an unsupported platform: hot reload degrades, the plugin works.
        log("opencode-mem: cannot watch config directory; hot reload disabled for it", {
          key,
          watchedDir: dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (entry.watchers.length === 0) {
      log("opencode-mem: no config directories watchable; hot reload disabled", { key });
      return () => {};
    }

    activeWatchers.set(key, entry);
    return entry.stop;
  } catch (error) {
    log("opencode-mem: failed to start config watcher; hot reload disabled", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }
}

/**
 * Stop the watcher for a key started by `startConfigWatcher`.
 * Returns true when a watcher was active.
 */
export function stopConfigWatcher(key: string): boolean {
  const entry = activeWatchers.get(key);
  if (!entry) {
    return false;
  }
  entry.stop();
  return true;
}

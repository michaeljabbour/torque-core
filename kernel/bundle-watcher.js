import { watch } from 'node:fs';
import { sep } from 'node:path';

/**
 * BundleWatcher — monitors bundle directories for file changes and triggers hot reload.
 *
 * Usage:
 *   const watcher = new BundleWatcher(registry, { wsHub, silent, debounceMs: 300 });
 *   watcher.start(); // begins watching all loaded bundle directories
 *   watcher.stop();  // closes all watchers and clears pending timers
 */
export class BundleWatcher {
  /**
   * @param {object} registry - Registry instance with activeBundles(), bundleDir(), reloadBundle()
   * @param {object} [opts]
   * @param {object} [opts.wsHub] - WebSocketHub with .clients Map for notifying browser clients
   * @param {boolean} [opts.silent] - Suppress log output
   * @param {number} [opts.debounceMs=300] - Debounce delay in ms for rapid change events
   */
  constructor(registry, opts = {}) {
    this._registry = registry;
    this._wsHub = opts.wsHub || null;
    this._silent = opts.silent || false;
    this._debounceMs = opts.debounceMs ?? 300;

    /** @type {Map<string, import('node:fs').FSWatcher>} */
    this._watchers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this._timers = new Map();
  }

  /**
   * Start watching all loaded bundle directories.
   */
  start() {
    for (const name of this._registry.activeBundles()) {
      this._watchBundle(name);
    }
  }

  /**
   * Watch a single bundle directory for .js and .yml file changes.
   * Skips migrations/ subdirectory.
   * @param {string} name - Bundle name
   */
  _watchBundle(name) {
    const dir = this._registry.bundleDir(name);
    if (!dir) return;

    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Skip migrations directory
        if (filename.includes('migrations/') || filename.startsWith('migrations' + sep)) return;

        // Only respond to .js and .yml file changes
        if (!filename.endsWith('.js') && !filename.endsWith('.yml')) return;

        this._debounce(name, () => this._reloadBundle(name));
      });

      this._watchers.set(name, watcher);
    } catch (e) {
      if (!this._silent) {
        console.warn(`[bundle-watcher] Could not watch bundle '${name}' at ${dir}: ${e.message}`);
      }
    }
  }

  /**
   * Debounce rapid file change events.
   * @param {string} name - Bundle name (used as debounce key)
   * @param {Function} fn - Function to call after debounce delay
   */
  _debounce(name, fn) {
    if (this._timers.has(name)) {
      clearTimeout(this._timers.get(name));
    }
    const timer = setTimeout(() => {
      this._timers.delete(name);
      fn();
    }, this._debounceMs);
    this._timers.set(name, timer);
  }

  /**
   * Reload a bundle and notify WebSocket clients.
   * Handles reload failures gracefully (logs but does not throw).
   * @param {string} name - Bundle name
   */
  async _reloadBundle(name) {
    if (!this._silent) {
      console.log(`[bundle-watcher] Reloading bundle '${name}'...`);
    }
    try {
      const result = await this._registry.reloadBundle(name);
      if (!this._silent) {
        console.log(`[bundle-watcher] Bundle '${name}' reloaded (result: ${result})`);
      }
      this._notifyClients(name);
    } catch (e) {
      if (!this._silent) {
        console.error(`[bundle-watcher] Failed to reload bundle '${name}': ${e.message}`);
      }
    }
  }

  /**
   * Notify all connected WebSocket clients that a bundle was reloaded.
   * Sends: { type: '__torque_reload', bundle, timestamp }
   * @param {string} bundleName
   */
  _notifyClients(bundleName) {
    if (!this._wsHub) return;

    const message = JSON.stringify({
      type: '__torque_reload',
      bundle: bundleName,
      timestamp: Date.now(),
    });

    for (const [client] of this._wsHub.clients) {
      // Only send to open connections (readyState 1 = OPEN)
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (e) {
          // Client may have disconnected — ignore send errors
        }
      }
    }
  }

  /**
   * Stop all file watchers and clear pending debounce timers.
   */
  stop() {
    for (const [name, watcher] of this._watchers) {
      try { watcher.close(); } catch {}
    }
    this._watchers.clear();

    for (const [name, timer] of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
  }
}

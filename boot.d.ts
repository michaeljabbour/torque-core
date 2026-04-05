/**
 * @torquedev/core/boot — TypeScript declarations
 */

import type { Registry, HookBus } from './index.js';

// ── BootOptions ───────────────────────────────────────────────────────────────

export interface BootOptions {
  /** Mount plan path or inline object */
  plan?: string | Record<string, unknown>;
  /** Database connection options */
  db?: Record<string, unknown>;
  /** HTTP port to bind (default: 9292) */
  port?: number;
  /** Directory of frontend static assets */
  frontendDir?: string;
  /** Express/connect middleware for shell (e.g. React SPA) */
  shell?: unknown;
  /** Custom auth resolver function */
  authResolver?: (req: unknown) => unknown;
  /** Whether to start an HTTP server (default: true) */
  serve?: boolean;
  /** Suppress boot logging (default: false) */
  silent?: boolean;
}

// ── BootResult ────────────────────────────────────────────────────────────────

export interface BootResult {
  registry: Registry;
  dataLayer: unknown;
  eventBus: unknown;
  hookBus: HookBus;
  /** Express app (present when serve: true) */
  app?: unknown;
  /** Bound port (present when serve: true) */
  port?: number;
  /** WebSocket hub (present when serve: true and ws is available) */
  wsHub?: unknown;
}

// ── boot() ────────────────────────────────────────────────────────────────────

export declare function boot(opts: BootOptions): Promise<BootResult>;

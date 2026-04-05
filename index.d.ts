/**
 * @torquedev/core — TypeScript declarations
 */

// ── Error Classes ─────────────────────────────────────────────────────────────

export declare class CircularDependencyError extends Error {
  readonly code: 'CIRCULAR_DEPENDENCY';
  readonly cyclePath: string[];
  constructor(cyclePath: string | string[]);
}

export declare class ContractViolationError extends Error {
  readonly code: 'CONTRACT_VIOLATION';
  readonly tag: string;
  readonly violationMessage: string;
  constructor(tag: string, message: string);
}

export declare class BundleNotFoundError extends Error {
  readonly code: 'BUNDLE_NOT_FOUND';
  readonly bundleName: string;
  readonly bundleDir: string;
  constructor(bundleName: string, bundleDir: string);
}

export declare class InterfaceNotFoundError extends Error {
  readonly code: 'INTERFACE_NOT_FOUND';
  readonly bundleName: string;
  readonly interfaceName: string;
  constructor(bundleName: string, interfaceName: string);
}

export declare class DependencyViolationError extends Error {
  readonly code: 'DEPENDENCY_VIOLATION';
  readonly callerBundle: string;
  readonly targetBundle: string;
  readonly declaredDeps: string[];
  constructor(callerBundle: string, targetBundle: string, declaredDeps: string[]);
}

// ── MountPlan ─────────────────────────────────────────────────────────────────

export interface MountPlan {
  app?: Record<string, unknown>;
  bundles?: Record<string, { enabled?: boolean; activation?: string; source?: string; [key: string]: unknown }>;
  validation?: { contracts?: 'warn' | 'strict'; events?: 'warn' | 'strict' };
  behaviors?: Array<string | { path: string }>;
  middleware?: Array<string | Record<string, unknown>>;
  context?: { include?: Array<string | { path: string }> };
  agents?: { include?: Array<string | { path: string }> };
}

// ── ScopedCoordinator ─────────────────────────────────────────────────────────

export declare class ScopedCoordinator {
  constructor(registry: Registry, bundleName: string, allowedBundles: string[]);
  call(
    targetBundle: string,
    interfaceName: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  spawn(targetBundle: string): ScopedCoordinator;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export declare class Registry {
  dataLayer: unknown;
  eventBus: unknown;
  hookBus: HookBus | null;
  bundles: Record<string, unknown>;
  interfaces: Record<string, unknown>;
  mountPlan: MountPlan | null;

  constructor(opts: {
    dataLayer: unknown;
    eventBus: unknown;
    createScopedData: (dataLayer: unknown, bundleName: string) => unknown;
    hookBus?: HookBus | null;
    typeValidator?: unknown;
    silent?: boolean;
  });

  boot(
    mountPlanPath: string | MountPlan,
    opts?: { sorted?: string[]; bundleDirs?: Record<string, string>; lock?: Record<string, unknown> }
  ): Promise<void>;

  loadBundle(name: string, config: Record<string, unknown>, bundleDir: string): Promise<void>;

  call(
    bundleName: string,
    interfaceName: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;

  activeBundles(): string[];
  bundleManifest(name: string): Record<string, unknown> | undefined;
  bundleInstance(name: string): unknown;
  bundleDir(name: string): string | undefined;
}

// ── HookBus ───────────────────────────────────────────────────────────────────

export declare class HookBus {
  on(
    position: string,
    handler: (context: Record<string, unknown>) => void | Promise<void>,
    opts?: { name?: string }
  ): void;

  gate(
    position: string,
    handler: (context: Record<string, unknown>) => void,
    opts?: { name?: string }
  ): void;

  runGate(position: string, context: Record<string, unknown>): void;

  emit(position: string, context: Record<string, unknown>): Promise<void>;

  emitSync(position: string, context: Record<string, unknown>): void;

  summary(): Record<string, string[]>;
}

// ── WebSocketHub ──────────────────────────────────────────────────────────────

export declare class WebSocketHub {
  constructor(
    eventBus: unknown,
    opts?: { authResolver?: (req: unknown) => unknown }
  );
  handleUpgrade(httpServer: unknown): Promise<void>;
}

// ── JobRunner ─────────────────────────────────────────────────────────────────

export declare class JobRunner {
  constructor(
    dataLayer: unknown,
    eventBus: unknown,
    opts?: { silent?: boolean }
  );
  registerBundle(bundleName: string, manifest: Record<string, unknown>, instance: unknown): void;
  createScopedJobs(bundleName: string): {
    enqueue(jobName: string, payload?: Record<string, unknown>): string;
    enqueueIn(delayMs: number, jobName: string, payload?: Record<string, unknown>): string;
    enqueueAt(date: Date, jobName: string, payload?: Record<string, unknown>): string;
  };
  start(intervalMs?: number): void;
}

// ── IDD Primitives ────────────────────────────────────────────────────────────

export declare class Intent {
  name: string;
  description: string;
  trigger?: string | ((...args: unknown[]) => unknown);
  successCriteria: string[];
  behavior: Behavior | null;

  constructor(opts: {
    name: string;
    description: string;
    trigger?: string | ((...args: unknown[]) => unknown);
    successCriteria?: string[];
    behavior?: Behavior;
  });

  useBehavior(behavior: Behavior): this;
  toJSON(): Record<string, unknown>;
}

export declare class Behavior {
  persona: string;
  allowedTools: string[];
  requireHumanConfirmation: string[];

  constructor(opts: {
    persona?: string;
    allowedTools?: string[];
    requireHumanConfirmation?: string[];
  });

  toJSON(): Record<string, unknown>;
}

export declare class Context {
  name: string;
  schema: Record<string, unknown>;
  vectorize: string[];

  constructor(
    name: string,
    opts: { schema?: Record<string, unknown>; vectorize?: string[] }
  );

  toJSON(): Record<string, unknown>;
}

export declare class AgentRouter {
  intents: Intent[];
  context: Context[];
  provider: string;

  constructor(opts: {
    intents?: Intent[];
    context?: Context[];
    provider?: string;
  });

  static create(opts: {
    intents?: Intent[];
    context?: Context[];
    provider?: string;
  }): AgentRouter;

  handle(
    payload: unknown,
    systemHookBus?: HookBus
  ): Promise<{ status: string; agentResponse: string; intents: string[] }>;
}

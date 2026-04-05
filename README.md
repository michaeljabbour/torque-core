# @torquedev/core

The kernel of the Torque composable monolith framework. Resolves bundles from git, boots them in dependency order, enforces composability contracts at runtime, and provides the lifecycle infrastructure (registry, hooks, coordinator) that lets independently developed bundles work together in a single process.

## Install

```bash
npm install @torquedev/core
```

Or as a git dependency:

```json
{
  "dependencies": {
    "@torquedev/core": "github:torque-framework/torque-core"
  }
}
```

**Runtime dependency:** `js-yaml` (only). No build step. ESM-only (`"type": "module"`).

## Overview

```
Mount Plan (YAML)
    |
    v
Resolver                          Fetches bundles from git / local paths
    |                             Topological sort by depends_on
    v
Registry                          Boots each bundle in order:
    |                               1. Register schema (tables)
    |                               2. Register declared events
    |                               3. import() logic.js -> instantiate class
    |                               4. Wire interfaces + coordinator
    |                               5. Fire lifecycle hooks
    v
HookBus                           Lifecycle hooks + authorization gates
    |
    v
Running application               Bundles communicate via events + coordinator
```

The kernel provides **mechanisms** -- it never decides policy. What bundles to load, how to authenticate, what events to publish: those are all bundle decisions. The kernel just enforces the contracts between them.

## Quick Start

```js
import { boot } from '@torquedev/core/boot';

const { registry, dataLayer, eventBus, hookBus, app } = await boot({
  plan: './mount-plan.yml',
  db: './data/app.sqlite3',
  port: 9292,
});
```

This resolves all bundles, boots them in dependency order, starts an Express server, and returns live handles to every kernel service.

## Concepts

### Mount Plan

A YAML file that defines your application:

```yaml
app:
  name: "my-app"

validation:
  contracts: strict    # 'warn' (default) | 'strict'
  events: warn         # 'warn' (default) | 'strict'

bundles:
  identity:
    source: "git+https://github.com/torque-framework/torque-bundle-identity.git@main"
    config:
      jwt_secret: "${AUTH_SECRET}"

  kanban:
    source: "git+https://github.com/torque-framework/torque-bundle-kanban.git@main"
```

Environment variables are interpolated: `${VAR}` (required, throws if missing) and `${?VAR}` (optional, empty string if missing).

### Bundle

A directory with two required files:

```
my-bundle/
  manifest.yml    <- Declarative contract
  logic.js        <- Implementation
  agent.md        <- (optional) AI agent definition
```

**`manifest.yml`** declares everything the kernel needs to know:

```yaml
name: kanban
version: 0.1.0

depends_on:
  - boards

schema:
  tables:
    cards:
      id: { type: text, primary: true }
      title: { type: text, required: true }
      list_id: { type: text, required: true }
      created_at: { type: text }

events:
  publishes:
    - name: kanban.card.created

interfaces:
  queries:
    - getCard
    - getBoardSnapshot
  contracts:
    getCard:
      output:
        shape:
          id: string
          title: string
          list_id: string

api:
  routes:
    - GET /api/cards/:id
    - POST /api/cards

ui:
  component: ./ui/index.jsx
```

**`logic.js`** implements the bundle's behavior:

```js
export default class Kanban {
  constructor({ data, events, config, coordinator }) {
    this.data = data;           // Scoped DB access (own tables only)
    this.events = events;       // Pub/sub
    this.config = config;       // From mount plan
    this.coordinator = coordinator;  // Cross-bundle RPC (restricted)
  }

  interfaces() {
    return {
      getCard: async ({ cardId }) => {
        return this.data.get('cards', cardId);
      },
      getBoardSnapshot: async ({ boardId }) => {
        const board = await this.coordinator.call('boards', 'getBoard', { boardId });
        const lists = await this.data.query('lists', { board_id: boardId });
        return { board, lists };
      },
    };
  }

  setupSubscriptions(eventBus) {
    eventBus.subscribe('boards.board.deleted', 'kanban', async ({ boardId }) => {
      await this.data.deleteWhere('lists', { board_id: boardId });
    });
  }
}
```

### Source Types

The resolver supports three bundle source types:

| Source | Syntax | Behavior |
|--------|--------|----------|
| Local | (no prefix) | Checks `bundles/<name>/` then `.bundles/<name>/` |
| Path | `path:../relative/path` | Copies into `.bundles/<name>/` |
| Git | `git+https://...@ref` | Clones/fetches, locks commit SHA in `bundle.lock` |

### Dependency Ordering

The resolver reads all `manifest.yml` files, builds a directed dependency graph from `depends_on`, and runs Kahn's topological sort. Every dependency boots before the bundles that depend on it. Circular dependencies throw `CircularDependencyError` with the exact cycle path.

### Composability Contracts

The central architectural idea: boundaries between bundles are **enforced contracts**, not conventions.

1. **Dependency enforcement** -- Each bundle receives a `ScopedCoordinator` that only allows calls to bundles declared in `depends_on` or `optional_deps`. Calling an undeclared dependency throws `DependencyViolationError` at runtime.

2. **Interface parity** -- If `manifest.yml` declares `getUser`, the class must implement it. If the class implements `getProfile`, the manifest must declare it. Bidirectional enforcement.

3. **Output shape contracts** -- Interfaces can declare expected return shapes. The kernel validates returned values include all declared fields.

4. **Event contracts** -- Bundles declare the events they publish. The EventBus can validate that only declared events are emitted.

5. **Boot-order contracts** -- Dependency order is computed, not configured. The topological sort guarantees correctness.

### Type-Checked Contract Validation

When a `typeValidator` is provided to `boot()`, the kernel validates input and output types at every interface boundary:

```js
import { boot } from '@torquedev/core/boot';
import { typeValidator } from '@torquedev/core/security';

const kernel = await boot({
  plan: './mount-plan.yml',
  db: './data/app.sqlite3',
  typeValidator,
});
```

The validator enforces the following rules on declared interface contracts:

| Rule | What is checked |
|------|----------------|
| Input required | All required input fields must be present |
| Input types | Input field values must match declared types |
| Output types | Output field values must match declared types |
| Array outputs | Array fields must be arrays, not single objects |
| Extra fields | Undeclared output fields trigger a warning in `warn` mode or throw in `strict` mode |
| Nullable | Fields declared as nullable may be `null`; non-nullable fields may not |

### Boot-Time Cross-Checks

During `boot()`, the kernel performs three cross-checks after all bundles are registered:

1. **Intents cross-check** -- Every intent declared in a bundle manifest must have a matching implementation in the bundle's class. Undeclared implementations are also flagged.
2. **Route handler check** -- Every route declared in `manifest.api.routes[]` must have a corresponding handler returned by `instance.routes()`.
3. **Event subscription check** -- Every event subscribed to in `setupSubscriptions()` must be published by some registered bundle (or the subscribing bundle must be in `optional_deps` of the publisher).

### Security Utilities

Exported from `@torquedev/core/security`:

| Utility | Description |
|---------|-------------|
| `scrubSensitive(obj)` | Recursively removes fields matching common sensitive key patterns (`password`, `secret`, `token`, `key`, etc.) before logging or returning data to clients. |
| `computeFileHash(filePath)` | Returns a SHA-256 hex digest of a file's contents. Used internally to detect bundle tampering and verify git-sourced bundle integrity. |

### Validation Modes

```yaml
validation:
  contracts: strict   # throw on manifest/impl mismatch
  events: warn        # log warning on undeclared event publish
```

| Mode | Contracts | Events |
|------|-----------|--------|
| `warn` | `console.warn` on violations | `console.warn` on undeclared publishes |
| `strict` | Throws `ContractViolationError` | EventBus throws on undeclared events |

## API Reference

### `boot(options)` -- High-level launcher

```js
import { boot } from '@torquedev/core/boot';

const kernel = await boot({
  plan,            // Path to mount-plan.yml (string)
  db,              // Database path for @torquedev/datalayer (string)
  port,            // HTTP port (default: 9292)
  frontendDir,     // Static file directory (optional)
  shell,           // Express middleware for SPA shell (optional)
  authResolver,    // Auth callback for @torquedev/server (optional)
  typeValidator,   // Type-check function for contract validation (optional)
  serve,           // Start HTTP server (default: true)
  silent,          // Suppress logging (default: false)
});

// Returns: { registry, dataLayer, eventBus, hookBus, app, port }
```

### `Resolver` -- Bundle resolution

```js
import { Resolver } from '@torquedev/core';

const resolver = new Resolver();

// Resolve + fetch all bundles, return sorted boot order
const { sorted, bundleDirs } = await resolver.resolve('./mount-plan.yml');

// Inspect lock state without fetching
const entries = await resolver.list('./mount-plan.yml');

// Validate dependency graph without fetching
const sorted = await resolver.check('./mount-plan.yml');

// Parse mount plan with env var interpolation
const plan = Resolver.loadMountPlan('./mount-plan.yml');
```

### `Registry` -- Runtime kernel

```js
import { Registry } from '@torquedev/core';

const registry = new Registry({
  dataLayer,          // @torquedev/datalayer instance
  eventBus,           // @torquedev/eventbus instance
  createScopedData,   // (dataLayer, bundleName) => BundleScopedData
  hookBus,            // HookBus instance (optional)
  silent,             // Suppress logging (default: false)
});

// Boot all bundles from mount plan
await registry.boot('./mount-plan.yml', { sorted, bundleDirs });

// Cross-bundle interface call (goes through gates + hooks)
const user = await registry.call('identity', 'getUser', { userId: '123' });

// Introspection
registry.activeBundles();        // ['identity', 'kanban', ...]
registry.bundleInstance('kanban'); // Live class instance
registry.bundleManifest('kanban'); // Parsed manifest.yml
registry.bundleDir('kanban');     // Resolved directory path
```

### `ScopedCoordinator` -- Capability-restricted proxy

Each bundle receives a `ScopedCoordinator` instead of direct registry access. It restricts calls to declared dependencies:

```js
// Inside a bundle that depends_on: [identity]
await coordinator.call('identity', 'getUser', { userId: '123' });  // allowed
await coordinator.call('billing', 'charge', {});  // throws DependencyViolationError
```

### `HookBus` -- Lifecycle hooks + gates

```js
import { HookBus } from '@torquedev/core';

const hookBus = new HookBus();

// Hooks (observers -- errors swallowed, never block)
hookBus.on('interface:before-call', (ctx) => { /* log, audit, trace */ });
hookBus.on('interface:after-call', (ctx) => { /* ctx includes durationMs */ });
hookBus.on('interface:error', (ctx) => { /* ctx includes error */ });
hookBus.on('bundle:before-boot', (ctx) => { /* ctx: { bundleName, manifest } */ });
hookBus.on('bundle:after-boot', (ctx) => { /* ctx: { bundleName, durationMs } */ });

// Gates (enforcement -- errors propagate and abort the operation)
hookBus.gate('interface:gate', (ctx) => {
  if (!hasPermission(ctx)) throw new Error('Unauthorized');
});

// Emit
hookBus.emitSync('bundle:after-boot', { bundleName: 'kanban', durationMs: 42 });
await hookBus.emit('interface:after-call', { bundle: 'kanban', method: 'getCard' });
hookBus.runGate('interface:gate', { bundle: 'kanban', method: 'getCard', args });
```

**Hook positions:**
- `bundle:before-boot` / `bundle:after-boot`
- `interface:gate` (gate -- blocks if it throws)
- `interface:before-call` / `interface:after-call` / `interface:error`
- `event:before-publish` / `event:after-publish`
- `idd:intent_received` / `idd:executing`

### Error Classes

All exported from `@torquedev/core`:

| Class | Code | When |
|-------|------|------|
| `CircularDependencyError` | `CIRCULAR_DEPENDENCY` | `depends_on` graph has a cycle |
| `ContractViolationError` | `CONTRACT_VIOLATION` | Manifest/implementation mismatch (strict mode) |
| `BundleNotFoundError` | `BUNDLE_NOT_FOUND` | Bundle directory has no `manifest.yml` |
| `InterfaceNotFoundError` | `INTERFACE_NOT_FOUND` | `registry.call()` with unknown interface |
| `DependencyViolationError` | `DEPENDENCY_VIOLATION` | Bundle calls an undeclared dependency |

## Intent Primitives

The `idd/` layer provides intent primitives for AI agent integration:

```js
import { Intent, Behavior, Context, AgentRouter } from '@torquedev/core';

const intent = new Intent({
  name: 'analyzeProposal',
  description: 'Review a deal proposal and score it',
  trigger: 'proposal.submitted',
  successCriteria: ['score assigned', 'summary generated'],
}).useBehavior(new Behavior({
  persona: 'You are a precise deal analyst.',
  allowedTools: ['pipeline.getProposal', 'pulse.scoreProposal'],
  requireHumanConfirmation: ['pipeline.markApproved'],
}));

const router = AgentRouter.create({ intents: [intent], provider: 'anthropic' });
await router.handle(payload, hookBus);
```

| Class | Purpose |
|-------|---------|
| `Intent` | Goal declaration -- name, trigger, success criteria, Behavior binding |
| `Behavior` | Execution constraints -- persona, allowed tools, human confirmation gates |
| `Context` | Data shape -- schema fields, which to vector-index |
| `AgentRouter` | Routes payloads to matching Intents, fires HookBus events |

## Testing

```bash
npm test          # node --test test/*.test.js
```

10 test files covering: registry boot, resolver, dependency sort, hooks, lock files, error classes, and validation modes. Uses the Node.js built-in test runner -- no test framework dependencies.

## Project Structure

```
torque-core/
  index.js              Public API (13 named exports)
  boot.js               High-level boot() launcher (import via @torquedev/core/boot)
  kernel/
    registry.js          Registry + ScopedCoordinator
    resolver.js          Bundle resolution + mount plan parsing
    hooks.js             HookBus (lifecycle hooks + gates)
    errors.js            5 typed error classes
    security.js          scrubSensitive + computeFileHash utilities
    resolver/
      cache.js           .bundles/ cache management
      deps.js            Topological sort (Kahn's algorithm)
      git.js             git clone/fetch for git+https:// sources
      lock.js            bundle.lock read/write
      path.js            path: source type handling
  idd/
    Intent.js            Intent "Why" primitive
    Behavior.js          Intent "How" primitive
    Context.js           Intent "What" primitive
    AgentRouter.js       Routes payloads through intents
  test/                  10 test files (node --test)
```

## Background Jobs (Feature 13)

Bundles can declare background jobs in their manifest:

```yaml
jobs:
  - name: reindex
    handler: reindexAll
    schedule: "0 */6 * * *"        # cron syntax (every 6 hours)
    retry: { max: 3, backoff: exponential }
    timeout: 300s
    events_on_complete:
      - search-app.reindex.completed
```

The framework provides `this.jobs` to bundle instances:

```js
// Enqueue immediately
this.jobs.enqueue('reindex', { scope: 'workspace-123' });

// Enqueue with delay
this.jobs.enqueueIn(30000, 'cleanup', { olderThan: '30d' });

// Enqueue at specific time
this.jobs.enqueueAt(new Date('2025-01-01'), 'report', {});
```

Jobs are persisted to SQLite (`_torque_jobs` table) for crash recovery. No Redis or external queue needed. The job runner polls every 5 seconds and executes jobs in-process (composable monolith advantage).

**Retry behavior:** Failed jobs retry with configurable backoff (exponential or linear). After `max` attempts, the job is marked as failed.

**Cron scheduling:** Jobs with a `schedule` field run automatically. The cron parser supports minute, hour, day-of-month, month, day-of-week with `*` and `*/N` step syntax.

## WebSocket Hub (Feature B5)

Real-time event push via WebSocket. The `WebSocketHub` bridges the EventBus to connected browser clients.

```js
import { WebSocketHub } from '@torquedev/core';

const hub = new WebSocketHub(eventBus, { authResolver });
await hub.handleUpgrade(httpServer);
```

Clients connect to `ws://host:port/__torque_ws` and subscribe to channels:

```js
ws.send(JSON.stringify({ type: 'subscribe', channel: 'board:abc-123' }));
```

Events with `board_id` or `workspace_id` in their payload are automatically routed to the matching channel. A global `*` channel receives all events.

Auto-wired in `boot()` when the `ws` npm package is installed.

## Peer Dependencies

The kernel lazy-imports these at boot time (not required for isolated testing):

| Package | Used By | Purpose |
|---------|---------|---------|
| `@torquedev/datalayer` | `boot()` | SQLite storage |
| `@torquedev/eventbus` | `boot()` | Pub/sub |
| `@torquedev/server` | `boot()` with `serve: true` | Express HTTP server |
| `ws` | `boot()` (optional) | WebSocket real-time push |

## License

MIT — see [LICENSE](./LICENSE)

/**
 * Tests for boot-time cross-checks added in Phase 3:
 *   1. intents: manifest vs intents() return — bidirectional
 *   2. api.routes[].handler existence in routes()
 *   3. events.subscribes vs actual subscriptions — post-setupSubscriptions
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../kernel/registry.js';
import { ContractViolationError } from '../kernel/errors.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockDataLayer() {
  return {
    registerSchema: () => {},
    tablesFor: () => [],
  };
}

function createMockEventBus(subscriptionMap = {}) {
  const subs = new Map();
  return {
    _subs: subs,
    subscriptions() {
      const result = { ...subscriptionMap };
      for (const [event, bundles] of subs) {
        result[event] = [...(result[event] || []), ...bundles];
      }
      return result;
    },
    subscribe(event, bundleName) {
      if (!subs.has(event)) subs.set(event, []);
      subs.get(event).push(bundleName);
    },
    registerDeclaredEvents: () => {},
    registerEventSchemas: () => {},
    setValidationMode: () => {},
  };
}

/**
 * Write a minimal bundle to a temp dir and return the dir path.
 *
 * @param {object} manifest  - parsed manifest object (will be YAML-serialised)
 * @param {string} logicCode - ES module source for logic.js
 */
function writeTempBundle(manifest, logicCode) {
  const dir = join(tmpdir(), `torque-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  // Serialise manifest to YAML manually (no dep on js-yaml here)
  writeFileSync(join(dir, 'manifest.yml'), toYaml(manifest), 'utf8');
  writeFileSync(join(dir, 'logic.js'), logicCode, 'utf8');
  return dir;
}

/** Minimal YAML serialiser sufficient for our test manifests */
function toYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`${pad}${k}:`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else if (typeof v[0] === 'string') {
        lines.push(`${pad}${k}:`);
        for (const item of v) lines.push(`${pad}  - ${item}`);
      } else if (typeof v[0] === 'object') {
        lines.push(`${pad}${k}:`);
        for (const item of v) {
          const entries = Object.entries(item);
          const inline = entries.map(([ik, iv]) => `${ik}: ${iv}`).join(', ');
          lines.push(`${pad}  - { ${inline} }`);
        }
      }
    } else if (typeof v === 'object') {
      lines.push(`${pad}${k}:`);
      lines.push(toYaml(v, indent + 2));
    } else {
      lines.push(`${pad}${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

function makeRegistry({ mode = 'strict', eventBus } = {}) {
  const reg = new Registry({
    dataLayer: createMockDataLayer(),
    eventBus: eventBus || createMockEventBus(),
    createScopedData: () => ({}),
    silent: true,
  });
  reg._validationMode = mode;
  return reg;
}

// ── 1. Intents cross-check ────────────────────────────────────────────────────

describe('Registry boot – intents cross-check', () => {
  it('throws in strict mode when manifest declares an intent not returned by intents()', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        intents: ['OrganizeWork', 'MissingIntent'],
        interfaces: { queries: [], contracts: {} },
      },
      `export default class {
        interfaces() { return {}; }
        intents() { return { OrganizeWork: {} }; }
      }`
    );

    const reg = makeRegistry();
    await assert.rejects(
      () => reg.loadBundle('myBundle', { enabled: true }, dir),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('MissingIntent'), `Expected MissingIntent in: ${err.message}`);
        return true;
      }
    );
  });

  it('throws in strict mode when intents() returns a key not declared in manifest', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        intents: ['OrganizeWork'],
        interfaces: { queries: [], contracts: {} },
      },
      `export default class {
        interfaces() { return {}; }
        intents() { return { OrganizeWork: {}, UndeclaredExtra: {} }; }
      }`
    );

    const reg = makeRegistry();
    await assert.rejects(
      () => reg.loadBundle('myBundle', { enabled: true }, dir),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('UndeclaredExtra'), `Expected UndeclaredExtra in: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when manifest intents and intents() keys match exactly', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        intents: ['OrganizeWork', 'TrackProgress'],
        interfaces: { queries: [], contracts: {} },
      },
      `export default class {
        interfaces() { return {}; }
        intents() { return { OrganizeWork: {}, TrackProgress: {} }; }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
  });

  it('passes when both manifest and intents() have no intents declared', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
      },
      `export default class {
        interfaces() { return {}; }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
  });

  it('warns (does not throw) in warn mode for intent mismatch', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        intents: ['OrganizeWork', 'Ghost'],
        interfaces: { queries: [], contracts: {} },
      },
      `export default class {
        interfaces() { return {}; }
        intents() { return { OrganizeWork: {} }; }
      }`
    );

    const reg = makeRegistry({ mode: 'warn' });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
      assert.ok(warnings.some(w => w.includes('Ghost')), 'expected Ghost in warnings');
    } finally {
      console.warn = origWarn;
    }
  });

  it('throws when manifest declares intent but bundle has no intents() method', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        intents: ['OrganizeWork'],
        interfaces: { queries: [], contracts: {} },
      },
      `export default class {
        interfaces() { return {}; }
        // no intents() method
      }`
    );

    const reg = makeRegistry();
    await assert.rejects(
      () => reg.loadBundle('myBundle', { enabled: true }, dir),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('OrganizeWork'));
        return true;
      }
    );
  });
});

// ── 2. api.routes[].handler cross-check ──────────────────────────────────────

describe('Registry boot – route handler cross-check', () => {
  it('throws in strict mode when a declared route handler is missing from routes()', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        api: {
          routes: [
            { method: 'GET', path: '/api/items', handler: 'listItems', auth: true },
            { method: 'POST', path: '/api/items', handler: 'createItem', auth: true },
          ],
        },
      },
      `export default class {
        interfaces() { return {}; }
        routes() {
          return {
            listItems: async (req) => [],
            // createItem is intentionally missing
          };
        }
      }`
    );

    const reg = makeRegistry();
    await assert.rejects(
      () => reg.loadBundle('myBundle', { enabled: true }, dir),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('createItem'), `Expected createItem in: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when all declared route handlers are present in routes()', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        api: {
          routes: [
            { method: 'GET', path: '/api/items', handler: 'listItems', auth: true },
          ],
        },
      },
      `export default class {
        interfaces() { return {}; }
        routes() { return { listItems: async () => [] }; }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
  });

  it('skips the check when routes array is empty', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        api: { routes: [] },
      },
      `export default class {
        interfaces() { return {}; }
        routes() { return {}; }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
  });

  it('skips routes without a handler field (no crash)', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        api: {
          routes: [
            { method: 'GET', path: '/api/items' },  // no handler field
          ],
        },
      },
      `export default class {
        interfaces() { return {}; }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
  });

  it('warns (does not throw) in warn mode for missing handler', async () => {
    const dir = writeTempBundle(
      {
        name: 'myBundle',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        api: {
          routes: [
            { method: 'DELETE', path: '/api/items/:id', handler: 'removeItem', auth: true },
          ],
        },
      },
      `export default class {
        interfaces() { return {}; }
        routes() { return {}; }
      }`
    );

    const reg = makeRegistry({ mode: 'warn' });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await assert.doesNotReject(() => reg.loadBundle('myBundle', { enabled: true }, dir));
      assert.ok(warnings.some(w => w.includes('removeItem')), 'expected removeItem in warnings');
    } finally {
      console.warn = origWarn;
    }
  });
});

// ── 3. events.subscribes cross-check (post-setupSubscriptions) ───────────────

describe('Registry boot – events.subscribes cross-check', () => {
  it('throws in strict mode when a declared subscription was never registered', async () => {
    // Bundle declares it subscribes but setupSubscriptions never calls eventBus.subscribe
    const dir = writeTempBundle(
      {
        name: 'listener',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        events: { subscribes: ['some.event'] },
      },
      `export default class {
        interfaces() { return {}; }
        setupSubscriptions(eventBus) {
          // intentionally not subscribing to 'some.event'
        }
      }`
    );

    // Pass validation.contracts: strict in the mount plan so boot() picks it up
    // (boot() overwrites _validationMode from the mount plan, not from the constructor)
    const reg = makeRegistry();
    await assert.rejects(
      () => reg.boot(
        { bundles: { listener: { enabled: true } }, validation: { contracts: 'strict' } },
        { sorted: ['listener'], bundleDirs: { listener: dir } }
      ),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('some.event'), `Expected some.event in: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when declared subscription is actually registered', async () => {
    const dir = writeTempBundle(
      {
        name: 'listener',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        events: { subscribes: ['some.event'] },
      },
      `export default class {
        interfaces() { return {}; }
        setupSubscriptions(eventBus) {
          eventBus.subscribe('some.event', 'listener', () => {});
        }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(
      () => reg.boot(
        { bundles: { listener: { enabled: true } } },
        { sorted: ['listener'], bundleDirs: { listener: dir } }
      )
    );
  });

  it('warns (does not throw) in warn mode for undeclared subscription', async () => {
    const dir = writeTempBundle(
      {
        name: 'listener',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        events: { subscribes: ['missing.event'] },
      },
      `export default class {
        interfaces() { return {}; }
        setupSubscriptions(eventBus) {
          // not subscribing to missing.event
        }
      }`
    );

    const reg = makeRegistry({ mode: 'warn' });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await assert.doesNotReject(
        () => reg.boot(
          { bundles: { listener: { enabled: true } } },
          { sorted: ['listener'], bundleDirs: { listener: dir } }
        )
      );
      assert.ok(
        warnings.some(w => w.includes('missing.event')),
        `expected missing.event in warnings, got: ${warnings.join('; ')}`
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('skips the check when events.subscribes is empty or absent', async () => {
    const dir = writeTempBundle(
      {
        name: 'listener',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
      },
      `export default class { interfaces() { return {}; } }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(
      () => reg.boot(
        { bundles: { listener: { enabled: true } } },
        { sorted: ['listener'], bundleDirs: { listener: dir } }
      )
    );
  });

  it('passes when bundle subscribes to multiple events and all are registered', async () => {
    const dir = writeTempBundle(
      {
        name: 'listener',
        version: '1.0.0',
        interfaces: { queries: [], contracts: {} },
        events: { subscribes: ['event.a', 'event.b'] },
      },
      `export default class {
        interfaces() { return {}; }
        setupSubscriptions(eventBus) {
          eventBus.subscribe('event.a', 'listener', () => {});
          eventBus.subscribe('event.b', 'listener', () => {});
        }
      }`
    );

    const reg = makeRegistry();
    await assert.doesNotReject(
      () => reg.boot(
        { bundles: { listener: { enabled: true } } },
        { sorted: ['listener'], bundleDirs: { listener: dir } }
      )
    );
  });
});

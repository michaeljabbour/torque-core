import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, ScopedCoordinator } from '../kernel/registry.js';
import {
  ContractViolationError,
  InterfaceNotFoundError,
  DependencyViolationError,
} from '../kernel/errors.js';

function createMockDataLayer() {
  return {
    schemas: {},
    registerSchema(bundleName, tables) { this.schemas[bundleName] = tables; },
    tablesFor(bundle) { return Object.keys(this.schemas[bundle] || {}); },
  };
}

function createMockEventBus() {
  return {
    _validationMode: 'warn',
    _declaredEvents: new Map(),
    _unsubscribedBundles: [],
    setValidationMode(mode) { this._validationMode = mode; },
    registerDeclaredEvents(name, events) { this._declaredEvents.set(name, events); },
    registerEventSchemas() {},
    subscribers: new Map(),
    subscribe() {},
    subscriptions() { return {}; },
    unsubscribeBundle(bundleName) { this._unsubscribedBundles.push(bundleName); },
  };
}

describe('ScopedCoordinator', () => {
  it('allows calls to declared dependencies', async () => {
    let called = false;
    const mockRegistry = {
      call: async () => { called = true; return { ok: true }; },
    };
    const sc = new ScopedCoordinator(mockRegistry, 'pulse', ['pipeline', 'identity']);
    await sc.call('pipeline', 'getDeal', { dealId: '123' });
    assert.ok(called);
  });

  it('throws DependencyViolationError for undeclared dependencies', async () => {
    const mockRegistry = { call: async () => ({}) };
    const sc = new ScopedCoordinator(mockRegistry, 'pulse', ['pipeline']);
    await assert.rejects(
      () => sc.call('billing', 'getInvoice', {}),
      (err) => {
        assert.equal(err.name, 'DependencyViolationError');
        assert.equal(err.code, 'DEPENDENCY_VIOLATION');
        assert.ok(err.message.includes('billing'));
        return true;
      }
    );
  });
});

describe('Registry', () => {
  let registry, dataLayer, eventBus;

  beforeEach(() => {
    dataLayer = createMockDataLayer();
    eventBus = createMockEventBus();
    registry = new Registry({
      dataLayer,
      eventBus,
      createScopedData: (dl, name) => ({ _bundle: name }),
    });
  });

  describe('call()', () => {
    it('throws InterfaceNotFoundError for missing interface', async () => {
      await assert.rejects(
        () => registry.call('nonexistent', 'doSomething', {}),
        (err) => {
          assert.equal(err.name, 'InterfaceNotFoundError');
          assert.equal(err.code, 'INTERFACE_NOT_FOUND');
          return true;
        }
      );
    });

    it('routes calls through registered interface handlers', async () => {
      registry.interfaces['myBundle.greet'] = async ({ name }) => `Hello ${name}`;
      const result = await registry.call('myBundle', 'greet', { name: 'World' });
      assert.equal(result, 'Hello World');
    });
  });

  describe('_contractViolation()', () => {
    it('warns in warn mode', () => {
      registry._contractViolation('test.iface', 'field missing');
    });

    it('throws ContractViolationError in strict mode', () => {
      registry._validationMode = 'strict';
      assert.throws(
        () => registry._contractViolation('test.iface', 'field missing'),
        (err) => {
          assert.equal(err.name, 'ContractViolationError');
          assert.equal(err.code, 'CONTRACT_VIOLATION');
          return true;
        }
      );
    });
  });

  describe('accessor methods', () => {
    it('activeBundles() returns empty array initially', () => {
      assert.deepEqual(registry.activeBundles(), []);
    });
    it('bundleInstance() returns undefined for unloaded bundle', () => {
      assert.equal(registry.bundleInstance('nonexistent'), undefined);
    });
    it('bundleManifest() returns undefined for unloaded bundle', () => {
      assert.equal(registry.bundleManifest('nonexistent'), undefined);
    });
  });

  describe('unloadBundle()', () => {
    function seedBundle(name) {
      // Manually seed registry state as if loadBundle() had run
      registry.bundles[name] = {
        manifest: { version: '1.0.0', events: {} },
        instance: {},
        config: {},
        dir: `/bundles/${name}`,
        intents: {},
      };
      registry.interfaces[`${name}.doThing`] = async () => ({ ok: true });
      registry.interfaces[`${name}.otherMethod`] = async () => ({ ok: true });
      // Add an agent associated with this bundle
      registry._agents.push({ meta: { name: `${name} agent` }, body: 'test', bundle: name });
    }

    it('removes bundle from this.bundles', () => {
      seedBundle('alpha');
      assert.ok(registry.bundles['alpha'], 'alpha should exist before unload');

      registry.unloadBundle('alpha');

      assert.equal(registry.bundles['alpha'], undefined, 'alpha should be removed from this.bundles');
    });

    it('removes all interfaces prefixed with bundle name', () => {
      seedBundle('alpha');
      assert.ok(registry.interfaces['alpha.doThing'], 'interface should exist before unload');
      assert.ok(registry.interfaces['alpha.otherMethod'], 'interface should exist before unload');

      registry.unloadBundle('alpha');

      assert.equal(registry.interfaces['alpha.doThing'], undefined, 'alpha.doThing should be removed');
      assert.equal(registry.interfaces['alpha.otherMethod'], undefined, 'alpha.otherMethod should be removed');
    });

    it('calls eventBus.unsubscribeBundle with the bundle name', () => {
      seedBundle('alpha');

      registry.unloadBundle('alpha');

      assert.ok(eventBus._unsubscribedBundles.includes('alpha'), 'eventBus.unsubscribeBundle should be called with alpha');
    });

    it('returns false for a bundle that does not exist', () => {
      const result = registry.unloadBundle('nonexistent');
      assert.equal(result, false);
    });

    it('removes agents registered by the bundle', () => {
      seedBundle('alpha');
      const agentsBefore = registry._agents.filter(a => a.bundle === 'alpha');
      assert.equal(agentsBefore.length, 1, 'should have one agent before unload');

      registry.unloadBundle('alpha');

      const agentsAfter = registry._agents.filter(a => a.bundle === 'alpha');
      assert.equal(agentsAfter.length, 0, 'agents for alpha should be removed');
    });
  });
});

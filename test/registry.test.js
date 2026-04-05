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
    setValidationMode(mode) { this._validationMode = mode; },
    registerDeclaredEvents(name, events) { this._declaredEvents.set(name, events); },
    registerEventSchemas() {},
    subscribers: new Map(),
    subscribe() {},
    subscriptions() { return {}; },
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
});

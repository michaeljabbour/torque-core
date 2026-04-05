/**
 * Tests for registry.js using formal error classes (task-2).
 * These tests verify that the four error throw sites use formal error classes
 * instead of plain Error objects.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScopedCoordinator, Registry } from '../kernel/registry.js';
import {
  DependencyViolationError,
  InterfaceNotFoundError,
  ContractViolationError,
  BundleNotFoundError,
} from '../kernel/errors.js';

function createMockDataLayer() {
  return {
    registerSchema: () => {},
    tablesFor: () => [],
  };
}

function createMockEventBus() {
  return {
    subscriptions: () => ({}),
    registerDeclaredEvents: () => {},
    registerEventSchemas: () => {},
    subscribe: () => {},
    setValidationMode: () => {},
  };
}

// ─── 1. ScopedCoordinator.call() ────────────────────────────────────────────

describe('ScopedCoordinator.call() - DependencyViolationError', () => {
  it('throws DependencyViolationError (not plain Error) for disallowed bundle', async () => {
    const mockRegistry = { call: async () => {} };
    const coordinator = new ScopedCoordinator(mockRegistry, 'callerBundle', ['allowedBundle']);

    await assert.rejects(
      () => coordinator.call('disallowedBundle', 'someMethod', {}),
      (err) => {
        assert.ok(err instanceof DependencyViolationError,
          `Expected DependencyViolationError, got ${err.constructor.name}`);
        assert.equal(err.name, 'DependencyViolationError');
        assert.equal(err.code, 'DEPENDENCY_VIOLATION');
        return true;
      }
    );
  });

  it('DependencyViolationError carries correct callerBundle, targetBundle, declaredDeps', async () => {
    const mockRegistry = { call: async () => {} };
    const coordinator = new ScopedCoordinator(mockRegistry, 'myBundle', ['dep1', 'dep2']);

    await assert.rejects(
      () => coordinator.call('undeclaredBundle', 'someMethod', {}),
      (err) => {
        assert.equal(err.callerBundle, 'myBundle');
        assert.equal(err.targetBundle, 'undeclaredBundle');
        assert.ok(Array.isArray(err.declaredDeps));
        assert.deepEqual(err.declaredDeps, ['dep1', 'dep2']);
        return true;
      }
    );
  });
});

// ─── 2. Registry.call() ─────────────────────────────────────────────────────

describe('Registry.call() - InterfaceNotFoundError', () => {
  it('throws InterfaceNotFoundError (not plain Error) for missing interface', async () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    await assert.rejects(
      () => registry.call('someBundle', 'missingInterface', {}),
      (err) => {
        assert.ok(err instanceof InterfaceNotFoundError,
          `Expected InterfaceNotFoundError, got ${err.constructor.name}`);
        assert.equal(err.name, 'InterfaceNotFoundError');
        assert.equal(err.code, 'INTERFACE_NOT_FOUND');
        return true;
      }
    );
  });

  it('InterfaceNotFoundError carries correct bundleName and interfaceName', async () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    await assert.rejects(
      () => registry.call('myBundle', 'myInterface', {}),
      (err) => {
        assert.equal(err.bundleName, 'myBundle');
        assert.equal(err.interfaceName, 'myInterface');
        return true;
      }
    );
  });
});

// ─── 3. Registry._contractViolation() ───────────────────────────────────────

describe('Registry._contractViolation() - ContractViolationError', () => {
  it('throws ContractViolationError (not plain Error) in strict mode', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });
    registry._validationMode = 'strict';

    assert.throws(
      () => registry._contractViolation('bundle.iface', 'some violation'),
      (err) => {
        assert.ok(err instanceof ContractViolationError,
          `Expected ContractViolationError, got ${err.constructor.name}`);
        assert.equal(err.name, 'ContractViolationError');
        assert.equal(err.code, 'CONTRACT_VIOLATION');
        return true;
      }
    );
  });

  it('ContractViolationError carries correct tag and violationMessage in strict mode', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });
    registry._validationMode = 'strict';

    assert.throws(
      () => registry._contractViolation('bundle.iface', 'missing field'),
      (err) => {
        assert.equal(err.tag, 'bundle.iface');
        assert.equal(err.violationMessage, 'missing field');
        return true;
      }
    );
  });

  it('does not throw in warn mode — uses console.warn instead', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });
    registry._validationMode = 'warn';

    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args);
    try {
      assert.doesNotThrow(() => registry._contractViolation('bundle.iface', 'violation'));
      assert.equal(warns.length, 1, 'expected console.warn to be called once');
    } finally {
      console.warn = origWarn;
    }
  });
});

// ─── 4. Registry.loadBundle() ───────────────────────────────────────────────

describe('Registry.loadBundle() - BundleNotFoundError', () => {
  it('throws BundleNotFoundError (not silently returning) when manifest not found', async () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    await assert.rejects(
      () => registry.loadBundle('missingBundle', {}, '/nonexistent/path/that/does/not/exist'),
      (err) => {
        assert.ok(err instanceof BundleNotFoundError,
          `Expected BundleNotFoundError, got ${err.constructor.name}`);
        assert.equal(err.name, 'BundleNotFoundError');
        assert.equal(err.code, 'BUNDLE_NOT_FOUND');
        return true;
      }
    );
  });

  it('BundleNotFoundError carries correct bundleName and bundleDir', async () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    await assert.rejects(
      () => registry.loadBundle('myBundle', {}, '/nonexistent/bundle/path'),
      (err) => {
        assert.equal(err.bundleName, 'myBundle');
        assert.equal(err.bundleDir, '/nonexistent/bundle/path');
        return true;
      }
    );
  });
});

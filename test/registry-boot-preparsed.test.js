/**
 * Tests for registry.boot() accepting pre-parsed mount plan objects (task-6).
 * K3: boot() should accept either a file path string or a pre-parsed object.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../kernel/registry.js';

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

// ─── 1. boot() accepts a pre-parsed object ──────────────────────────────────

describe('Registry.boot() - accepts pre-parsed mount plan object', () => {
  it('sets mountPlan directly when passed a plain object', async () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    const plan = { bundles: {} };
    await registry.boot(plan);

    assert.deepEqual(registry.mountPlan, plan,
      'mountPlan should be the pre-parsed object passed to boot()');
  });

  it('does not attempt to read a file when passed an object', async () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    // Passing a non-existent path as an object property — if it tried to
    // read a file with this value it would throw.  The test would fail.
    const plan = { bundles: {}, validation: { contracts: 'warn', events: 'warn' } };
    // Should NOT throw (no file I/O attempted)
    await assert.doesNotReject(
      () => registry.boot(plan),
      'boot() should not throw when given a pre-parsed object'
    );
  });

  it('reads validation modes from pre-parsed object', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });

    await registry.boot({ bundles: {}, validation: { contracts: 'strict', events: 'warn' } });

    assert.equal(registry._validationMode, 'strict',
      '_validationMode should be strict from pre-parsed object');
    assert.equal(registry._eventValidationMode, 'warn',
      '_eventValidationMode should be warn from pre-parsed object');
  });
});

// ─── 2. boot() still works with a file path string ──────────────────────────

describe('Registry.boot() - still accepts string file path (backward compat)', () => {
  it('uses Resolver.loadMountPlan when passed a string path', async () => {
    const { writeFileSync, mkdirSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const dir = join(tmpdir(), `torque-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'mount-plan.yml');
    writeFileSync(filePath, 'bundles: {}\n', 'utf8');

    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });

    await registry.boot(filePath);
    assert.ok(registry.mountPlan, 'mountPlan should be set after booting from file path');
    assert.deepEqual(registry.mountPlan.bundles, {},
      'mountPlan.bundles should be empty from the temp file');
  });
});

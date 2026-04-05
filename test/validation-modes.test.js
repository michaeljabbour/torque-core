/**
 * Tests for split validation modes (task-5):
 * - Registry has both _validationMode (contracts) and _eventValidationMode (events)
 * - boot() reads them independently from mount plan
 * - EventBus receives _eventValidationMode, not _validationMode
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Registry } from '../kernel/registry.js';

function createMockDataLayer() {
  return {
    registerSchema: () => {},
    tablesFor: () => [],
  };
}

function createMockEventBus() {
  const calls = [];
  return {
    subscriptions: () => ({}),
    registerDeclaredEvents: () => {},
    registerEventSchemas: () => {},
    subscribe: () => {},
    setValidationMode: (mode) => calls.push(mode),
    _calls: calls,
  };
}

/**
 * Write a minimal mount plan YAML to a temp file and return its path.
 * Accepts optional validation config object.
 */
function writeTempMountPlan(validation = {}) {
  const dir = join(tmpdir(), `torque-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'mount-plan.yml');
  // Simple scalar keys only — no quoting needed for 'strict'/'warn'
  const validationSection = Object.keys(validation).length > 0
    ? `validation:\n${Object.entries(validation).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`
    : '';
  const yaml = `${validationSection}bundles: {}\n`;
  writeFileSync(filePath, yaml, 'utf8');
  return filePath;
}

// ─── 1. Constructor ──────────────────────────────────────────────────────────

describe('Registry constructor - split validation modes', () => {
  it('has _validationMode initialized to warn', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });
    assert.equal(registry._validationMode, 'warn');
  });

  it('has _eventValidationMode initialized to warn', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });
    assert.equal(registry._eventValidationMode, 'warn');
  });

  it('_eventValidationMode is independent of _validationMode', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: () => ({}),
    });
    // Both should exist as separate properties
    assert.ok('_validationMode' in registry, 'missing _validationMode');
    assert.ok('_eventValidationMode' in registry, 'missing _eventValidationMode');
  });
});

// ─── 2. boot() reads validation.contracts and validation.events independently ─

describe('Registry.boot() - reads validation modes independently', () => {
  it('sets _validationMode from validation.contracts', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    const planPath = writeTempMountPlan({ contracts: 'strict', events: 'warn' });
    await registry.boot(planPath);
    assert.equal(registry._validationMode, 'strict');
  });

  it('sets _eventValidationMode from validation.events', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    const planPath = writeTempMountPlan({ contracts: 'warn', events: 'strict' });
    await registry.boot(planPath);
    assert.equal(registry._eventValidationMode, 'strict');
  });

  it('_validationMode and _eventValidationMode can differ after boot', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    const planPath = writeTempMountPlan({ contracts: 'strict', events: 'warn' });
    await registry.boot(planPath);
    assert.equal(registry._validationMode, 'strict');
    assert.equal(registry._eventValidationMode, 'warn');
  });

  it('defaults both to warn when validation section is absent', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    const planPath = writeTempMountPlan(); // no validation section
    await registry.boot(planPath);
    assert.equal(registry._validationMode, 'warn');
    assert.equal(registry._eventValidationMode, 'warn');
  });
});

// ─── 3. EventBus receives _eventValidationMode, not _validationMode ──────────

describe('Registry.boot() - EventBus receives event validation mode', () => {
  it('calls setValidationMode with _eventValidationMode value (not contracts mode)', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    // contracts=strict, events=warn — EventBus should get 'warn' (events mode)
    const planPath = writeTempMountPlan({ contracts: 'strict', events: 'warn' });
    await registry.boot(planPath);
    assert.equal(eventBus._calls.length, 1, 'setValidationMode should be called once');
    assert.equal(eventBus._calls[0], 'warn',
      'EventBus should receive events mode (warn), not contracts mode (strict)');
  });

  it('calls setValidationMode with strict when validation.events is strict', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    // contracts=warn, events=strict — EventBus should get 'strict'
    const planPath = writeTempMountPlan({ contracts: 'warn', events: 'strict' });
    await registry.boot(planPath);
    assert.equal(eventBus._calls.length, 1);
    assert.equal(eventBus._calls[0], 'strict',
      'EventBus should receive events mode (strict)');
  });

  it('does not propagate contracts strictness to EventBus', async () => {
    const eventBus = createMockEventBus();
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus,
      createScopedData: () => ({}),
    });
    // contracts=warn, events=strict — EventBus must get 'strict' (events), not 'warn' (contracts)
    const planPath = writeTempMountPlan({ contracts: 'warn', events: 'strict' });
    await registry.boot(planPath);
    assert.equal(registry._validationMode, 'warn');
    assert.equal(registry._eventValidationMode, 'strict');
    assert.equal(eventBus._calls[0], 'strict',
      'EventBus should receive events mode (strict), not contracts mode (warn)');
  });
});

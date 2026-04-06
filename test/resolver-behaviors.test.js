/**
 * Tests for validateBehavior() (task-1 RED phase).
 * Verifies that validateBehavior() accepts valid behaviors, rejects behaviors
 * missing required keys, and rejects forbidden keys/nested keys.
 *
 * Expected: FAIL — `Cannot find module '../kernel/resolver/behaviors.js'`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBehavior } from '../kernel/resolver/behaviors.js';

describe('validateBehavior()', () => {
  it('accepts a valid behavior with all allowed keys', () => {
    const behavior = {
      name: 'my-behavior',
      version: '1.0.0',
      description: 'A test behavior',
      extensions: [],
      hooks: {},
      gates: {},
      events: {},
      config: {},
      permissions: [],
      jobs: [],
      context: {},
      agents: [],
    };
    assert.doesNotThrow(() => validateBehavior(behavior));
  });

  it('accepts a minimal behavior with only name', () => {
    const behavior = { name: 'minimal-behavior' };
    assert.doesNotThrow(() => validateBehavior(behavior));
  });

  it('rejects a behavior missing name (error includes "name")', () => {
    const behavior = { version: '1.0.0', description: 'No name here' };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('name'), `Expected error to include "name", got: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects forbidden key: schema (error includes "schema")', () => {
    const behavior = { name: 'bad-behavior', schema: {} };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('schema'), `Expected error to include "schema", got: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects forbidden key: routes (error includes "routes")', () => {
    const behavior = { name: 'bad-behavior', routes: [] };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('routes'), `Expected error to include "routes", got: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects forbidden key: interfaces (error includes "interfaces")', () => {
    const behavior = { name: 'bad-behavior', interfaces: [] };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('interfaces'), `Expected error to include "interfaces", got: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects forbidden key: intents (error includes "intents")', () => {
    const behavior = { name: 'bad-behavior', intents: [] };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('intents'), `Expected error to include "intents", got: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects forbidden key: ui (error includes "ui")', () => {
    const behavior = { name: 'bad-behavior', ui: {} };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('ui'), `Expected error to include "ui", got: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects forbidden nested key events.publishes (error includes "events.publishes")', () => {
    const behavior = { name: 'bad-behavior', events: { publishes: [] } };
    assert.throws(
      () => validateBehavior(behavior),
      (err) => {
        assert.ok(err.message.includes('events.publishes'), `Expected error to include "events.publishes", got: ${err.message}`);
        return true;
      }
    );
  });
});

/**
 * Tests for resolver/behaviors.js.
 * Covers two functions:
 *   - validateBehavior(): accepts valid behaviors, rejects behaviors missing
 *     required keys, and rejects forbidden keys/nested keys.
 *   - expandEventWildcards(): resolves wildcard subscribe patterns against a
 *     bundle's published event list, returning expanded events and warnings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as behaviors from '../kernel/resolver/behaviors.js';
const { validateBehavior, expandEventWildcards } = behaviors;

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

describe('expandEventWildcards()', () => {
  const bundlePublishes = [
    { name: 'broker.partner.created' },
    { name: 'broker.partner.updated' },
    { name: 'broker.partner.deleted' },
    { name: 'broker.exchange.created' },
    { name: 'broker.exchange.deleted' },
  ];

  it('expands *.created to matching events with no warnings', () => {
    const { expanded, warnings } = expandEventWildcards(['*.created'], bundlePublishes);
    assert.deepEqual(expanded.sort(), ['broker.exchange.created', 'broker.partner.created']);
    assert.equal(warnings.length, 0);
  });

  it('expands *.deleted to matching events with no warnings', () => {
    const { expanded, warnings } = expandEventWildcards(['*.deleted'], bundlePublishes);
    assert.deepEqual(expanded.sort(), ['broker.exchange.deleted', 'broker.partner.deleted']);
    assert.equal(warnings.length, 0);
  });

  it('passes through fully-qualified event unchanged with no warnings', () => {
    const { expanded, warnings } = expandEventWildcards(['identity.user.created'], bundlePublishes);
    assert.deepEqual(expanded, ['identity.user.created']);
    assert.equal(warnings.length, 0);
  });

  it('handles mix of wildcards and fully-qualified events', () => {
    const { expanded, warnings } = expandEventWildcards(['*.created', 'identity.user.created'], bundlePublishes);
    assert.ok(expanded.includes('broker.partner.created'), 'should include broker.partner.created');
    assert.ok(expanded.includes('broker.exchange.created'), 'should include broker.exchange.created');
    assert.ok(expanded.includes('identity.user.created'), 'should include identity.user.created');
    assert.equal(warnings.length, 0);
  });

  it('returns warning when wildcard matches zero events', () => {
    const { warnings } = expandEventWildcards(['*.archived'], bundlePublishes);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('*.archived'), `Warning should include '*.archived', got: ${warnings[0]}`);
    assert.ok(warnings[0].includes('0'), `Warning should include '0', got: ${warnings[0]}`);
  });

  it('handles empty subscribes list returning empty expanded and no warnings', () => {
    const { expanded, warnings } = expandEventWildcards([], bundlePublishes);
    assert.deepEqual(expanded, []);
    assert.deepEqual(warnings, []);
  });

  it('handles empty publishes list returning warning for wildcard', () => {
    const { warnings } = expandEventWildcards(['*.created'], []);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('*.created'), `Warning should reference '*.created', got: ${warnings[0]}`);
  });

  it('normalizes object-format subscribes to strings', () => {
    const subscribes = [{ event: 'pipeline.deal.created' }, { event: '*.updated' }];
    const { expanded } = expandEventWildcards(subscribes, bundlePublishes);
    assert.ok(expanded.includes('pipeline.deal.created'), 'should include pipeline.deal.created');
    assert.ok(expanded.includes('broker.partner.updated'), 'should include broker.partner.updated');
  });

  it('deduplicates expanded events when wildcard and explicit name both match', () => {
    const { expanded } = expandEventWildcards(['broker.partner.created', '*.created'], bundlePublishes);
    const count = expanded.filter((e) => e === 'broker.partner.created').length;
    assert.equal(count, 1, 'broker.partner.created should appear only once');
  });
});

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
const { validateBehavior, expandEventWildcards, resolveBehaviors } = behaviors;

describe('validateBehavior()', () => {
  it('accepts a valid behavior with all allowed keys', () => {
    const behavior = {
      name: 'my-behavior',
      version: '1.0.0',
      description: 'A test behavior',
      extensions: [],
      hooks: [],
      gates: [],
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

  it('throws TypeError (not plain Error) for invalid subscribe entry', () => {
    assert.throws(
      () => expandEventWildcards([null], bundlePublishes),
      (err) => {
        assert.ok(err instanceof TypeError, `Expected TypeError, got: ${err.constructor.name}`);
        return true;
      }
    );
  });

  it('returns a warning specifically about multiple wildcards for patterns with more than one *', () => {
    const { warnings } = expandEventWildcards(['*.*.created'], bundlePublishes);
    assert.ok(
      warnings.some((w) => w.toLowerCase().includes('multiple wildcard')),
      `Expected a warning about multiple wildcards, got: ${JSON.stringify(warnings)}`
    );
  });
});

describe('resolveBehaviors()', () => {
  const baseManifest = {
    name: 'broker',
    extensions: ['ext-core'],
    hooks: [{ position: 'boot:after', handler: 'core.init' }],
    events: {
      publishes: [
        { name: 'broker.partner.created' },
        { name: 'broker.partner.updated' },
        { name: 'broker.partner.deleted' },
      ],
      subscribes: ['broker.partner.created'],
    },
    config: { log_level: 'info' },
  };

  it('returns manifest unchanged when behaviors array is empty, deltas all 0', () => {
    const { manifest, deltas } = resolveBehaviors(structuredClone(baseManifest), []);
    assert.deepEqual(manifest, baseManifest);
    assert.equal(deltas.extensions, 0);
    assert.equal(deltas.hooks, 0);
    assert.equal(deltas.gates, 0);
    assert.equal(deltas.event_subscriptions, 0);
    assert.equal(deltas.jobs, 0);
  });

  it('merges extensions with union dedup — adding ext-search and ext-core results in ext-core,ext-search, deltas.extensions===1', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'ext-behavior', extensions: ['ext-search', 'ext-core'] };
    const { manifest: result, deltas } = resolveBehaviors(manifest, [behavior]);
    assert.deepEqual(result.extensions.sort(), ['ext-core', 'ext-search']);
    assert.equal(deltas.extensions, 1);
  });

  it('appends hooks from behavior — hooks.length===2, deltas.hooks===1', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'hook-behavior', hooks: [{ position: 'boot:before', handler: 'my.hook' }] };
    const { manifest: result, deltas } = resolveBehaviors(manifest, [behavior]);
    assert.equal(result.hooks.length, 2);
    assert.equal(deltas.hooks, 1);
  });

  it('appends gates from behavior — 2 gates added, deltas.gates===2', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = {
      name: 'gate-behavior',
      gates: [
        { name: 'require-auth', type: 'auth' },
        { name: 'require-role', type: 'role' },
      ],
    };
    const { manifest: result, deltas } = resolveBehaviors(manifest, [behavior]);
    assert.ok(Array.isArray(result.gates));
    assert.equal(result.gates.length, 2);
    assert.equal(deltas.gates, 2);
  });

  it('expands event wildcards and appends to subscribes with dedup — deltas.event_subscriptions===1 (only broker.partner.deleted is new)', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'event-behavior', events: { subscribes: ['*.created', '*.deleted'] } };
    const { manifest: result, deltas } = resolveBehaviors(manifest, [behavior]);
    assert.ok(result.events.subscribes.includes('broker.partner.created'));
    assert.ok(result.events.subscribes.includes('broker.partner.deleted'));
    assert.equal(deltas.event_subscriptions, 1);
  });

  it('deep merges config as defaults — behavior config auto_index added, manifest log_level wins over behavior log_level', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'config-behavior', config: { auto_index: true, log_level: 'debug' } };
    const { manifest: result } = resolveBehaviors(manifest, [behavior]);
    assert.equal(result.config.auto_index, true);
    assert.equal(result.config.log_level, 'info');
  });

  it('later behavior overrides earlier behavior config — behavior2 shared wins, manifest log_level wins over all', () => {
    const manifest = structuredClone(baseManifest);
    const behavior1 = { name: 'b1', config: { shared: 'first-wins', log_level: 'debug' } };
    const behavior2 = { name: 'b2', config: { shared: 'second-wins', log_level: 'warn' } };
    const { manifest: result } = resolveBehaviors(manifest, [behavior1, behavior2]);
    assert.equal(result.config.shared, 'second-wins');
    assert.equal(result.config.log_level, 'info');
  });

  it('deep merges permissions from behavior', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'perm-behavior', permissions: [{ action: 'read', resource: 'partners' }] };
    const { manifest: result } = resolveBehaviors(manifest, [behavior]);
    assert.ok(Array.isArray(result.permissions));
    assert.ok(result.permissions.some((p) => p.action === 'read' && p.resource === 'partners'));
  });

  it('appends jobs from behavior — deltas.jobs===1', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'job-behavior', jobs: [{ name: 'sync-job', handler: 'jobs.sync' }] };
    const { manifest: result, deltas } = resolveBehaviors(manifest, [behavior]);
    assert.ok(Array.isArray(result.jobs));
    assert.ok(result.jobs.some((j) => j.name === 'sync-job'));
    assert.equal(deltas.jobs, 1);
  });

  it('appends context.include from behavior', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'ctx-behavior', context: { include: ['shared/logging.js'] } };
    const { manifest: result } = resolveBehaviors(manifest, [behavior]);
    assert.ok(Array.isArray(result.context?.include));
    assert.ok(result.context.include.includes('shared/logging.js'));
  });

  it('appends agents.include from behavior', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'agent-behavior', agents: { include: ['agents/sync-agent.js'] } };
    const { manifest: result } = resolveBehaviors(manifest, [behavior]);
    assert.ok(Array.isArray(result.agents?.include));
    assert.ok(result.agents.include.includes('agents/sync-agent.js'));
  });

  it('throws on forbidden key schema in behavior', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'bad-behavior', schema: {} };
    assert.throws(
      () => resolveBehaviors(manifest, [behavior]),
      (err) => {
        assert.ok(err.message.includes('schema'), `Expected error to include "schema", got: ${err.message}`);
        return true;
      }
    );
  });

  it('collects wildcard warnings for unmatched wildcard *.archived', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = { name: 'warn-behavior', events: { subscribes: ['*.archived'] } };
    const { warnings } = resolveBehaviors(manifest, [behavior]);
    assert.ok(Array.isArray(warnings));
    assert.ok(warnings.length > 0, 'should have at least one warning');
    assert.ok(warnings.some((w) => w.includes('*.archived')), 'warning should mention *.archived');
  });

  it('does not mutate original manifest', () => {
    const original = structuredClone(baseManifest);
    const behavior = {
      name: 'mutate-test',
      extensions: ['ext-search'],
      hooks: [{ position: 'boot:before', handler: 'my.hook' }],
      config: { auto_index: true },
    };
    resolveBehaviors(original, [behavior]);
    assert.deepEqual(original, baseManifest);
  });

  it('handles behavior with object-format event subscribes [{event:pipeline.deal.created},{event:*.created}]', () => {
    const manifest = structuredClone(baseManifest);
    const behavior = {
      name: 'obj-event-behavior',
      events: { subscribes: [{ event: 'pipeline.deal.created' }, { event: '*.created' }] },
    };
    const { manifest: result } = resolveBehaviors(manifest, [behavior]);
    assert.ok(result.events.subscribes.includes('pipeline.deal.created'));
    assert.ok(result.events.subscribes.includes('broker.partner.created'));
  });
});

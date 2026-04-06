/**
 * Integration tests — Broker Boots with Behaviors.
 *
 * Tests resolver/behaviors.js against realistic fixtures modeled after the
 * real broker bundle manifest and torque-foundation behavior definitions.
 *
 * Covers:
 *   - audit-trail behavior (object-format subscribes, context, config merging)
 *   - security-hardened behavior (gates, hooks, nested config)
 *   - multiple behaviors applied in order (later behavior wins, manifest always wins)
 *   - wildcard expansion against 11 real broker events (dedup, deltas)
 *   - zero-match wildcard warning (behavior name, pattern, and '0' included)
 *   - forbidden key rejection (schema in behavior named 'sneaky')
 *   - all 5 foundation behaviors validate without error
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateBehavior, expandEventWildcards, resolveBehaviors } from '../kernel/resolver/behaviors.js';

describe('Broker Boots with Behaviors (integration)', () => {
  let brokerManifest;

  beforeEach(() => {
    brokerManifest = {
      name: 'broker',
      version: '1.0.0',
      extensions: [],
      hooks: [],
      events: {
        publishes: [
          { name: 'broker.partner.created' },
          { name: 'broker.partner.updated' },
          { name: 'broker.partner.deleted' },
          { name: 'broker.exchange.created' },
          { name: 'broker.exchange.deleted' },
          { name: 'broker.connector.created' },
          { name: 'broker.connector.deleted' },
          { name: 'broker.token.created' },
          { name: 'broker.token.deleted' },
          { name: 'broker.grant.created' },
          { name: 'broker.grant.deleted' },
        ],
        subscribes: ['broker.partner.created', 'broker.partner.updated'],
      },
      config: { log_level: 'info' },
    };
  });

  it('applies audit-trail behavior with object-format subscribes — pipeline events added, context.include has EVENT_PATTERNS.md, config merged, manifest log_level wins', () => {
    const auditTrail = {
      name: 'audit-trail',
      events: {
        subscribes: [
          { event: 'pipeline.deal.created' },
          { event: 'pipeline.deal.stage_changed' },
        ],
      },
      context: { include: ['EVENT_PATTERNS.md'] },
      config: { retention_days: 90, log_format: 'jsonl', log_level: 'debug' },
    };

    const { manifest: result } = resolveBehaviors(structuredClone(brokerManifest), [auditTrail]);

    assert.ok(
      result.events.subscribes.includes('pipeline.deal.created'),
      'subscribes should include pipeline.deal.created'
    );
    assert.ok(
      result.events.subscribes.includes('pipeline.deal.stage_changed'),
      'subscribes should include pipeline.deal.stage_changed'
    );
    assert.ok(
      Array.isArray(result.context?.include) && result.context.include.includes('EVENT_PATTERNS.md'),
      'context.include should have EVENT_PATTERNS.md'
    );
    assert.equal(result.config.retention_days, 90, 'config.retention_days should be 90');
    assert.equal(result.config.log_format, 'jsonl', 'config.log_format should be jsonl');
    assert.equal(result.config.log_level, 'info', 'manifest log_level should win over behavior log_level');
  });

  it('applies security-hardened behavior — 2 gates and 1 hook added, csrf:true, rate_limit is nested object', () => {
    const securityHardened = {
      name: 'security-hardened',
      hooks: [{ position: 'request:before', handler: 'security.validate' }],
      gates: [
        { name: 'require-auth', type: 'auth' },
        { name: 'csrf-check', type: 'csrf' },
      ],
      config: { csrf: true, rate_limit: { requests: 100, window: 60 } },
    };

    const { manifest: result, deltas } = resolveBehaviors(structuredClone(brokerManifest), [securityHardened]);

    assert.equal(result.gates.length, 2, 'should have 2 gates from behavior');
    assert.equal(deltas.gates, 2, 'deltas.gates should be 2');
    assert.equal(result.hooks.length, 1, 'should have 1 hook from behavior');
    assert.equal(deltas.hooks, 1, 'deltas.hooks should be 1');
    assert.equal(result.config.csrf, true, 'config.csrf should be true');
    assert.ok(
      result.config.rate_limit !== null &&
        typeof result.config.rate_limit === 'object' &&
        !Array.isArray(result.config.rate_limit),
      'config.rate_limit should be a nested object'
    );
  });

  it('applies multiple behaviors in order — observability then security-hardened — hooks and gates both applied, behavior2 config wins over behavior1 for shared keys, manifest config always wins', () => {
    const observability = {
      name: 'observability',
      hooks: [{ position: 'boot:after', handler: 'telemetry.init' }],
      config: { log_format: 'json', shared_key: 'observability-wins', log_level: 'debug' },
    };
    const securityHardened = {
      name: 'security-hardened',
      gates: [
        { name: 'require-auth', type: 'auth' },
        { name: 'csrf-check', type: 'csrf' },
      ],
      config: { csrf: true, shared_key: 'security-wins', log_level: 'warn' },
    };

    const { manifest: result } = resolveBehaviors(structuredClone(brokerManifest), [
      observability,
      securityHardened,
    ]);

    assert.ok(result.hooks.length >= 1, 'should have at least 1 hook (from observability)');
    assert.ok(result.gates.length >= 2, 'should have at least 2 gates (from security-hardened)');
    assert.equal(result.config.shared_key, 'security-wins', 'later behavior (security-hardened) config should win for shared keys');
    assert.equal(result.config.log_level, 'info', 'manifest config should always win over any behavior config');
  });

  it('wildcard expansion against 11 real broker events — *.created matches 5, *.deleted matches 5, dedup broker.partner.created, total subscribes 11, deltas.event_subscriptions===9, deltas.extensions===1', () => {
    const wildcardBehavior = {
      name: 'wildcard-subscriber',
      extensions: ['ext-analytics'],
      events: { subscribes: ['*.created', '*.deleted'] },
    };

    const { manifest: result, deltas } = resolveBehaviors(structuredClone(brokerManifest), [wildcardBehavior]);

    // Verify *.created expanded to 5 events (all 5 *.created from broker publishes)
    const createdEvents = result.events.subscribes.filter((e) => e.endsWith('.created'));
    assert.equal(createdEvents.length, 5, '*.created should expand to 5 events');

    // Verify *.deleted expanded to 5 events
    const deletedEvents = result.events.subscribes.filter((e) => e.endsWith('.deleted'));
    assert.equal(deletedEvents.length, 5, '*.deleted should expand to 5 events');

    // broker.partner.created was already in manifest — should appear exactly once (dedup)
    const dupCount = result.events.subscribes.filter((e) => e === 'broker.partner.created').length;
    assert.equal(dupCount, 1, 'broker.partner.created should appear only once (dedup)');

    // Total subscribes: 2 original + 9 new = 11
    assert.equal(result.events.subscribes.length, 11, 'total subscribes should be 11');

    // Delta: 9 new subscriptions added
    assert.equal(deltas.event_subscriptions, 9, 'deltas.event_subscriptions should be 9');

    // Delta: 1 extension added (ext-analytics)
    assert.equal(deltas.extensions, 1, 'deltas.extensions should be 1');
  });

  it('warns when *.archived matches zero events — warning includes behavior name, pattern, and "0"', () => {
    const archiveWatcher = {
      name: 'archive-watcher',
      events: { subscribes: ['*.archived'] },
    };

    const { warnings } = resolveBehaviors(structuredClone(brokerManifest), [archiveWatcher]);

    assert.ok(warnings.length > 0, 'should have at least one warning');
    const hasWarning = warnings.some(
      (w) => w.includes('archive-watcher') && w.includes('*.archived') && w.includes('0')
    );
    assert.ok(
      hasWarning,
      `Warning should include behavior name, pattern, and '0'. Got: ${JSON.stringify(warnings)}`
    );
  });

  it('rejects behavior with forbidden key schema — error includes "schema" and behavior name "sneaky"', () => {
    const sneakyBehavior = { name: 'sneaky', schema: { type: 'object', properties: {} } };

    assert.throws(
      () => resolveBehaviors(structuredClone(brokerManifest), [sneakyBehavior]),
      (err) => {
        assert.ok(
          err.message.includes('schema'),
          `Error should include 'schema', got: ${err.message}`
        );
        assert.ok(
          err.message.includes('sneaky'),
          `Error should include 'sneaky' (behavior name), got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('all 5 foundation behaviors validate without error', () => {
    const foundationBehaviors = [
      {
        name: 'security-hardened',
        hooks: [{ position: 'request:before', handler: 'security.validate' }],
        gates: [
          { name: 'require-auth', type: 'auth' },
          { name: 'csrf-check', type: 'csrf' },
        ],
        config: { csrf: true, rate_limit: { requests: 100, window: 60 } },
      },
      {
        name: 'observability',
        hooks: [{ position: 'boot:after', handler: 'telemetry.init' }],
        config: { log_format: 'json', telemetry: true },
      },
      {
        name: 'development',
        config: { debug: true, hot_reload: true },
      },
      {
        name: 'ai-assisted',
        context: { include: ['AI_CONTEXT.md'] },
        agents: { include: ['agents/ai-helper.js'] },
      },
      {
        name: 'audit-trail',
        events: {
          subscribes: [
            { event: 'pipeline.deal.created' },
            { event: 'pipeline.deal.stage_changed' },
          ],
        },
        context: { include: ['EVENT_PATTERNS.md'] },
        config: { retention_days: 90, log_format: 'jsonl' },
      },
    ];

    for (const behavior of foundationBehaviors) {
      assert.doesNotThrow(
        () => validateBehavior(behavior),
        `Foundation behavior '${behavior.name}' should validate without error`
      );
    }
  });
});

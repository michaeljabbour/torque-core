import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HookBus } from '../kernel/hooks.js';

describe('HookBus', () => {
  let hookBus;
  beforeEach(() => { hookBus = new HookBus(); });

  describe('on() + emitSync()', () => {
    it('calls registered handlers in order', () => {
      const order = [];
      hookBus.on('test:position', () => order.push('first'), { name: 'first' });
      hookBus.on('test:position', () => order.push('second'), { name: 'second' });
      hookBus.emitSync('test:position', {});
      assert.deepEqual(order, ['first', 'second']);
    });

    it('swallows errors in hook handlers', () => {
      hookBus.on('test:position', () => { throw new Error('boom'); }, { name: 'breaker' });
      hookBus.on('test:position', () => {}, { name: 'survivor' });
      hookBus.emitSync('test:position', {});
    });

    it('passes context to handlers', () => {
      let received;
      hookBus.on('test:position', (ctx) => { received = ctx; });
      hookBus.emitSync('test:position', { key: 'value' });
      assert.deepEqual(received, { key: 'value' });
    });
  });

  describe('on() + emit() (async)', () => {
    it('calls async handlers', async () => {
      let called = false;
      hookBus.on('test:async', async () => { called = true; });
      await hookBus.emit('test:async', {});
      assert.ok(called);
    });

    it('swallows errors in async handlers', async () => {
      hookBus.on('test:async', async () => { throw new Error('async boom'); });
      await hookBus.emit('test:async', {});
    });
  });

  describe('gate() + runGate()', () => {
    it('runs gate handlers in order', () => {
      const order = [];
      hookBus.gate('test:gate', () => order.push('gate1'), { name: 'gate1' });
      hookBus.gate('test:gate', () => order.push('gate2'), { name: 'gate2' });
      hookBus.runGate('test:gate', {});
      assert.deepEqual(order, ['gate1', 'gate2']);
    });

    it('propagates gate errors (does NOT swallow)', () => {
      hookBus.gate('test:gate', () => { throw new Error('rejected'); });
      assert.throws(() => hookBus.runGate('test:gate', {}), { message: 'rejected' });
    });

    it('passes context to gate handlers', () => {
      let received;
      hookBus.gate('test:gate', (ctx) => { received = ctx; });
      hookBus.runGate('test:gate', { bundle: 'identity', method: 'getUser' });
      assert.deepEqual(received, { bundle: 'identity', method: 'getUser' });
    });
  });

  describe('summary()', () => {
    it('lists registered hooks and gates', () => {
      hookBus.on('bundle:before-boot', () => {}, { name: 'audit-logger' });
      hookBus.gate('interface:gate', () => {}, { name: 'rate-limiter' });
      const summary = hookBus.summary();
      assert.deepEqual(summary['bundle:before-boot'], ['audit-logger']);
      assert.deepEqual(summary['interface:gate (gate)'], ['rate-limiter']);
    });

    it('returns empty object when nothing registered', () => {
      assert.deepEqual(hookBus.summary(), {});
    });
  });

  describe('no handlers registered', () => {
    it('emitSync with no listeners does not throw', () => {
      hookBus.emitSync('unregistered:position', {});
    });
    it('runGate with no gates does not throw', () => {
      hookBus.runGate('unregistered:gate', {});
    });
  });
});

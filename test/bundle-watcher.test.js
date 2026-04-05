import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BundleWatcher } from '../kernel/bundle-watcher.js';

function createMockRegistry(bundles = {}) {
  const store = {};
  for (const [name, dir] of Object.entries(bundles)) {
    store[name] = { dir };
  }
  return {
    store,
    activeBundles() { return Object.keys(store); },
    bundleDir(name) { return store[name]?.dir; },
    async reloadBundle(name) {
      if (!store[name]) return false;
      return true;
    },
  };
}

function createMockWsHub(clients = []) {
  return {
    clients: new Map(clients.map((c) => [c, {}])),
  };
}

describe('BundleWatcher', () => {
  it('constructs without errors', () => {
    const registry = createMockRegistry();
    assert.doesNotThrow(() => {
      const watcher = new BundleWatcher(registry, { silent: true });
      assert.ok(watcher, 'BundleWatcher should be instantiated');
    });
  });

  it('exposes start and stop methods', () => {
    const registry = createMockRegistry();
    const watcher = new BundleWatcher(registry, { silent: true });
    assert.equal(typeof watcher.start, 'function', 'start should be a function');
    assert.equal(typeof watcher.stop, 'function', 'stop should be a function');
  });

  it('_reloadBundle calls registry.reloadBundle', async () => {
    let reloaded = null;
    const registry = {
      activeBundles: () => ['my-bundle'],
      bundleDir: (name) => `/app/bundles/${name}`,
      reloadBundle: async (name) => { reloaded = name; return true; },
    };
    const watcher = new BundleWatcher(registry, { silent: true });
    await watcher._reloadBundle('my-bundle');
    assert.equal(reloaded, 'my-bundle', '_reloadBundle should call registry.reloadBundle with bundle name');
  });

  it('sends __torque_reload message via wsHub clients', async () => {
    const sent = [];
    const mockClient = {
      readyState: 1, // OPEN
      send(msg) { sent.push(JSON.parse(msg)); },
    };
    const wsHub = { clients: new Map([[mockClient, {}]]) };
    const registry = {
      activeBundles: () => ['notify-bundle'],
      bundleDir: (name) => `/app/bundles/${name}`,
      reloadBundle: async () => true,
    };
    const watcher = new BundleWatcher(registry, { wsHub, silent: true });
    await watcher._reloadBundle('notify-bundle');

    assert.equal(sent.length, 1, 'Should have sent one message to wsHub client');
    assert.equal(sent[0].type, '__torque_reload', 'Message type should be __torque_reload');
    assert.equal(sent[0].bundle, 'notify-bundle', 'Message should include bundle name');
    assert.ok(typeof sent[0].timestamp === 'number', 'Message should include timestamp');
  });

  it('handles reload failure gracefully (does not throw)', async () => {
    const registry = {
      activeBundles: () => ['failing-bundle'],
      bundleDir: (name) => `/app/bundles/${name}`,
      reloadBundle: async () => { throw new Error('reload failed'); },
    };
    const watcher = new BundleWatcher(registry, { silent: true });
    // Should not throw even when registry.reloadBundle throws
    await assert.doesNotReject(() => watcher._reloadBundle('failing-bundle'));
  });

  it('stop closes all watchers and clears timers', () => {
    const registry = createMockRegistry({ 'a-bundle': '/app/bundles/a-bundle' });
    const watcher = new BundleWatcher(registry, { silent: true });

    // Manually add fake watchers to simulate running state
    const closed = [];
    watcher._watchers.set('a-bundle', { close() { closed.push('a-bundle'); } });
    const timer = setTimeout(() => {}, 10000);
    watcher._timers.set('a-bundle', timer);

    watcher.stop();

    assert.equal(closed.length, 1, 'stop should close all watchers');
    assert.ok(closed.includes('a-bundle'), 'stop should close the a-bundle watcher');
    assert.equal(watcher._watchers.size, 0, 'stop should clear _watchers map');
    assert.equal(watcher._timers.size, 0, 'stop should clear _timers map');
  });
});

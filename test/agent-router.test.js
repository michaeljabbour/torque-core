import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCoordinator } from '../idd/AgentCoordinator.js';
import { AgentRouter } from '../idd/AgentRouter.js';

// ─── Mock Registry ─────────────────────────────────────────────────────────

function buildMockRegistry() {
  return {
    bundles: {
      orders: {
        manifest: {
          schema: {
            tables: {
              orders: {
                id: { type: 'uuid' },
                amount: { type: 'float' },
              },
            },
          },
          interfaces: {
            contracts: {
              getOrder: {
                description: 'Get an order by ID',
                input: [{ name: 'id', type: 'uuid', required: true }],
              },
            },
          },
        },
        intents: {
          ProcessOrder: {
            name: 'ProcessOrder',
            description: 'Process a customer order',
            behavior: {
              allowedTools: ['orders.getOrder'],
            },
          },
        },
      },
    },
    call: async (_bundleName, _interfaceName, _args) => ({ result: 'ok' }),
  };
}

// ─── Mock HookBus ────────────────────────────────────────────────────────────

function buildMockHookBus() {
  const emitted = [];
  return {
    emitted,
    emitSync(position, context) {
      emitted.push({ position, context });
    },
  };
}

// ─── Mock Runtime ────────────────────────────────────────────────────────────

function buildMockRuntime(overrideResult = null) {
  return {
    execute: async (_intent, _contextData, _toolDeclarations, _opts) =>
      overrideResult ?? { status: 'success', output: 'done', trace: ['t1', 't2'] },
  };
}

// ─── AgentCoordinator tests ──────────────────────────────────────────────────

describe('AgentCoordinator', () => {
  it('allows calls in allowedTools', async () => {
    const registry = buildMockRegistry();
    const coordinator = new AgentCoordinator(registry, ['orders.getOrder']);
    const result = await coordinator.call('orders', 'getOrder', { id: '123' });
    assert.deepEqual(result, { result: 'ok' });
  });

  it('rejects calls NOT in allowedTools', async () => {
    const registry = buildMockRegistry();
    const coordinator = new AgentCoordinator(registry, ['orders.getOrder']);
    await assert.rejects(
      () => coordinator.call('orders', 'deleteOrder', { id: '123' }),
      (err) => {
        assert.match(err.message, /not allowed by this intent's behavior/);
        return true;
      }
    );
  });

  it('rejects unknown bundles', async () => {
    const registry = buildMockRegistry();
    const coordinator = new AgentCoordinator(registry, ['orders.getOrder']);
    await assert.rejects(
      () => coordinator.call('unknown', 'someMethod', {}),
      (err) => {
        assert.match(err.message, /not allowed by this intent's behavior/);
        return true;
      }
    );
  });
});

// ─── AgentRouter tests ───────────────────────────────────────────────────────

describe('AgentRouter', () => {
  it('resolves intent and returns result', async () => {
    const registry = buildMockRegistry();
    const runtime = buildMockRuntime();
    const hookBus = buildMockHookBus();
    const router = new AgentRouter({ registry, runtime, hookBus });

    const result = await router.execute('orders', 'ProcessOrder', { foo: 'bar' });

    assert.equal(result.status, 'success');
    assert.equal(result.output, 'done');
  });

  it('emits idd:intent_received', async () => {
    const registry = buildMockRegistry();
    const runtime = buildMockRuntime();
    const hookBus = buildMockHookBus();
    const router = new AgentRouter({ registry, runtime, hookBus });

    await router.execute('orders', 'ProcessOrder', { foo: 'bar' });

    const received = hookBus.emitted.find((e) => e.position === 'idd:intent_received');
    assert.ok(received, 'should emit idd:intent_received');
    assert.equal(received.context.bundle, 'orders');
    assert.equal(received.context.intent.name, 'ProcessOrder');
    assert.deepEqual(received.context.input, { foo: 'bar' });
  });

  it('emits idd:resolved on success', async () => {
    const registry = buildMockRegistry();
    const runtime = buildMockRuntime();
    const hookBus = buildMockHookBus();
    const router = new AgentRouter({ registry, runtime, hookBus });

    await router.execute('orders', 'ProcessOrder', { foo: 'bar' });

    const resolved = hookBus.emitted.find((e) => e.position === 'idd:resolved');
    assert.ok(resolved, 'should emit idd:resolved');
    assert.equal(resolved.context.bundle, 'orders');
    assert.equal(resolved.context.status, 'success');
    assert.equal(resolved.context.traceLength, 2);
  });

  it('emits idd:failed when runtime throws', async () => {
    const registry = buildMockRegistry();
    const runtime = {
      execute: async () => {
        throw new Error('runtime failure');
      },
    };
    const hookBus = buildMockHookBus();
    const router = new AgentRouter({ registry, runtime, hookBus });

    const result = await router.execute('orders', 'ProcessOrder', {});

    assert.equal(result.status, 'failed');
    assert.equal(result.output, null);
    assert.ok(Array.isArray(result.trace), 'trace should be array');

    const failed = hookBus.emitted.find((e) => e.position === 'idd:failed');
    assert.ok(failed, 'should emit idd:failed');
    assert.equal(failed.context.bundle, 'orders');
    assert.match(failed.context.error.message, /runtime failure/);
  });

  it('throws when intent not found', async () => {
    const registry = buildMockRegistry();
    const runtime = buildMockRuntime();
    const hookBus = buildMockHookBus();
    const router = new AgentRouter({ registry, runtime, hookBus });

    await assert.rejects(
      () => router.execute('orders', 'NonExistentIntent', {}),
      (err) => {
        assert.match(err.message, /NonExistentIntent/);
        return true;
      }
    );
  });
});

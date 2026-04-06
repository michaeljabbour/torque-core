import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircularDependencyError,
  ContractViolationError,
  BundleNotFoundError,
  InterfaceNotFoundError,
  DependencyViolationError,
} from '../kernel/errors.js';

describe('CircularDependencyError', () => {
  it('extends Error', () => {
    const err = new CircularDependencyError(['a', 'b', 'a']);
    assert.ok(err instanceof Error);
  });

  it('has correct name', () => {
    const err = new CircularDependencyError(['a', 'b', 'a']);
    assert.equal(err.name, 'CircularDependencyError');
  });

  it('has correct code', () => {
    const err = new CircularDependencyError(['a', 'b', 'a']);
    assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
  });

  it('stores cyclePath param', () => {
    const path = ['a', 'b', 'a'];
    const err = new CircularDependencyError(path);
    assert.deepEqual(err.cyclePath, path);
  });

  it('has a message containing the cycle path', () => {
    const err = new CircularDependencyError(['a', 'b', 'a']);
    assert.match(err.message, /a -> b -> a/);
  });
});

describe('ContractViolationError', () => {
  it('extends Error', () => {
    const err = new ContractViolationError('bundle.iface', 'missing field');
    assert.ok(err instanceof Error);
  });

  it('has correct name', () => {
    const err = new ContractViolationError('bundle.iface', 'missing field');
    assert.equal(err.name, 'ContractViolationError');
  });

  it('has correct code', () => {
    const err = new ContractViolationError('bundle.iface', 'missing field');
    assert.equal(err.code, 'CONTRACT_VIOLATION');
  });

  it('stores tag param', () => {
    const err = new ContractViolationError('bundle.iface', 'missing field');
    assert.equal(err.tag, 'bundle.iface');
  });

  it('stores violationMessage param', () => {
    const err = new ContractViolationError('bundle.iface', 'missing field');
    assert.equal(err.violationMessage, 'missing field');
  });

  it('has a message', () => {
    const err = new ContractViolationError('bundle.iface', 'missing field');
    assert.match(err.message, /bundle\.iface/);
    assert.match(err.message, /missing field/);
  });
});

describe('BundleNotFoundError', () => {
  it('extends Error', () => {
    const err = new BundleNotFoundError('myBundle', 'bundles/myBundle');
    assert.ok(err instanceof Error);
  });

  it('has correct name', () => {
    const err = new BundleNotFoundError('myBundle', 'bundles/myBundle');
    assert.equal(err.name, 'BundleNotFoundError');
  });

  it('has correct code', () => {
    const err = new BundleNotFoundError('myBundle', 'bundles/myBundle');
    assert.equal(err.code, 'BUNDLE_NOT_FOUND');
  });

  it('stores bundleName param', () => {
    const err = new BundleNotFoundError('myBundle', 'bundles/myBundle');
    assert.equal(err.bundleName, 'myBundle');
  });

  it('stores bundleDir param', () => {
    const err = new BundleNotFoundError('myBundle', 'bundles/myBundle');
    assert.equal(err.bundleDir, 'bundles/myBundle');
  });

  it('has a message containing bundle name and path', () => {
    const err = new BundleNotFoundError('myBundle', 'bundles/myBundle');
    assert.match(err.message, /myBundle/);
    assert.match(err.message, /bundles\/myBundle/);
  });
});

describe('InterfaceNotFoundError', () => {
  it('extends Error', () => {
    const err = new InterfaceNotFoundError('myBundle', 'getUser');
    assert.ok(err instanceof Error);
  });

  it('has correct name', () => {
    const err = new InterfaceNotFoundError('myBundle', 'getUser');
    assert.equal(err.name, 'InterfaceNotFoundError');
  });

  it('has correct code', () => {
    const err = new InterfaceNotFoundError('myBundle', 'getUser');
    assert.equal(err.code, 'INTERFACE_NOT_FOUND');
  });

  it('stores bundleName param', () => {
    const err = new InterfaceNotFoundError('myBundle', 'getUser');
    assert.equal(err.bundleName, 'myBundle');
  });

  it('stores interfaceName param', () => {
    const err = new InterfaceNotFoundError('myBundle', 'getUser');
    assert.equal(err.interfaceName, 'getUser');
  });

  it('has a message containing bundle and interface names', () => {
    const err = new InterfaceNotFoundError('myBundle', 'getUser');
    assert.match(err.message, /myBundle/);
    assert.match(err.message, /getUser/);
  });
});

describe('CircularDependencyError defensive array handling', () => {
  it('does not throw TypeError when cyclePath is undefined', () => {
    assert.doesNotThrow(() => new CircularDependencyError(undefined));
  });

  it('does not throw TypeError when cyclePath is a string', () => {
    assert.doesNotThrow(() => new CircularDependencyError('a -> b -> a'));
  });

  it('produces a valid error instance when cyclePath is non-array', () => {
    const err = new CircularDependencyError(undefined);
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
  });
});

describe('DependencyViolationError defensive array handling', () => {
  it('does not throw TypeError when declaredDeps is undefined', () => {
    assert.doesNotThrow(() => new DependencyViolationError('a', 'b', undefined));
  });

  it('does not throw TypeError when declaredDeps is a string', () => {
    assert.doesNotThrow(() => new DependencyViolationError('a', 'b', 'dep1'));
  });

  it('produces a valid error instance when declaredDeps is non-array', () => {
    const err = new DependencyViolationError('a', 'b', undefined);
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'DEPENDENCY_VIOLATION');
  });
});

describe('DependencyViolationError', () => {
  it('extends Error', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1']);
    assert.ok(err instanceof Error);
  });

  it('has correct name', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1']);
    assert.equal(err.name, 'DependencyViolationError');
  });

  it('has correct code', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1']);
    assert.equal(err.code, 'DEPENDENCY_VIOLATION');
  });

  it('stores callerBundle param', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1']);
    assert.equal(err.callerBundle, 'callerA');
  });

  it('stores targetBundle param', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1']);
    assert.equal(err.targetBundle, 'targetB');
  });

  it('stores declaredDeps param', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1', 'dep2']);
    assert.deepEqual(err.declaredDeps, ['dep1', 'dep2']);
  });

  it('has a message containing caller and target bundle names', () => {
    const err = new DependencyViolationError('callerA', 'targetB', ['dep1']);
    assert.match(err.message, /callerA/);
    assert.match(err.message, /targetB/);
  });
});

describe('Error classes exported from @torquedev/core index', () => {
  it('all 5 error classes are exported from index.js', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    assert.ok(keys.includes('CircularDependencyError'), 'CircularDependencyError not exported');
    assert.ok(keys.includes('ContractViolationError'), 'ContractViolationError not exported');
    assert.ok(keys.includes('BundleNotFoundError'), 'BundleNotFoundError not exported');
    assert.ok(keys.includes('InterfaceNotFoundError'), 'InterfaceNotFoundError not exported');
    assert.ok(keys.includes('DependencyViolationError'), 'DependencyViolationError not exported');
  });

  it('existing exports still present alongside new error classes', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    assert.ok(keys.includes('Registry'), 'Registry not exported');
    assert.ok(keys.includes('ScopedCoordinator'), 'ScopedCoordinator not exported');
    assert.ok(keys.includes('Resolver'), 'Resolver not exported');
    assert.ok(keys.includes('HookBus'), 'HookBus not exported');
    assert.ok(keys.includes('WebSocketHub'), 'WebSocketHub not exported');
    assert.ok(keys.includes('JobRunner'), 'JobRunner not exported');
    assert.ok(keys.includes('Intent'), 'Intent not exported');
    assert.ok(keys.includes('Behavior'), 'Behavior not exported');
    assert.ok(keys.includes('Context'), 'Context not exported');
    assert.ok(keys.includes('AgentRouter'), 'AgentRouter not exported');
  });

  it('total exports are 20 (6 existing + 5 errors + 6 IDD primitives + 3 behavior resolution)', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    // 6 existing: Registry, ScopedCoordinator, Resolver, HookBus, WebSocketHub, JobRunner
    // 5 errors: CircularDependencyError, ContractViolationError, BundleNotFoundError,
    //           InterfaceNotFoundError, DependencyViolationError
    // 6 IDD primitives: Intent, Behavior, Context, AgentRouter, AgentCoordinator, ClaudeRuntime
    // 3 behavior resolution: resolveBehaviors, validateBehavior, expandEventWildcards
    assert.equal(keys.length, 20, `Expected 20 exports, got ${keys.length}: ${keys.join(', ')}`);
  });
});

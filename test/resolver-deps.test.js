/**
 * Tests for resolveDependencyOrder() using CircularDependencyError class (task-3).
 * Verifies that circular dependencies throw CircularDependencyError (not plain Error)
 * and that the error includes a cycle path with '->' notation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveDependencyOrder } from '../kernel/resolver/deps.js';
import { CircularDependencyError } from '../kernel/errors.js';

/**
 * Creates a temp directory with a manifest.yml file declaring given deps.
 */
function makeTempBundle(name, deps = []) {
  const dir = mkdtempSync(join(tmpdir(), `torque-test-${name}-`));
  const depsYaml = deps.length > 0
    ? `depends_on:\n${deps.map(d => `  - ${d}`).join('\n')}`
    : '';
  writeFileSync(join(dir, 'manifest.yml'), `name: ${name}\n${depsYaml}\n`);
  return dir;
}

describe('resolveDependencyOrder() - CircularDependencyError', () => {
  it('throws CircularDependencyError (not plain Error) on circular deps', () => {
    const dirA = makeTempBundle('a', ['b']);
    const dirB = makeTempBundle('b', ['a']);

    assert.throws(
      () => resolveDependencyOrder({ a: dirA, b: dirB }, ['a', 'b']),
      (err) => {
        assert.ok(
          err instanceof CircularDependencyError,
          `Expected CircularDependencyError, got ${err.constructor.name}`
        );
        assert.equal(err.name, 'CircularDependencyError');
        assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
        return true;
      }
    );
  });

  it('CircularDependencyError cycle path contains "->"', () => {
    const dirA = makeTempBundle('a', ['b']);
    const dirB = makeTempBundle('b', ['a']);

    assert.throws(
      () => resolveDependencyOrder({ a: dirA, b: dirB }, ['a', 'b']),
      (err) => {
        const pathStr = Array.isArray(err.cyclePath)
          ? err.cyclePath.join(' -> ')
          : String(err.cyclePath);
        assert.ok(
          pathStr.includes('->'),
          `cycle path should contain '->', got: "${pathStr}"`
        );
        return true;
      }
    );
  });

  it('CircularDependencyError cycle path mentions bundles in the cycle', () => {
    const dirA = makeTempBundle('alpha', ['beta']);
    const dirB = makeTempBundle('beta', ['alpha']);

    assert.throws(
      () => resolveDependencyOrder({ alpha: dirA, beta: dirB }, ['alpha', 'beta']),
      (err) => {
        const pathStr = Array.isArray(err.cyclePath)
          ? err.cyclePath.join(' -> ')
          : String(err.cyclePath);
        assert.ok(
          pathStr.includes('alpha') && pathStr.includes('beta'),
          `cycle path should mention both bundles, got: "${pathStr}"`
        );
        return true;
      }
    );
  });

  it('three-bundle cycle throws CircularDependencyError with -> notation', () => {
    const dirA = makeTempBundle('x', ['y']);
    const dirB = makeTempBundle('y', ['z']);
    const dirC = makeTempBundle('z', ['x']);

    assert.throws(
      () => resolveDependencyOrder({ x: dirA, y: dirB, z: dirC }, ['x', 'y', 'z']),
      (err) => {
        assert.ok(
          err instanceof CircularDependencyError,
          `Expected CircularDependencyError, got ${err.constructor.name}`
        );
        const pathStr = Array.isArray(err.cyclePath)
          ? err.cyclePath.join(' -> ')
          : String(err.cyclePath);
        assert.ok(pathStr.includes('->'), `expected -> in path, got: "${pathStr}"`);
        return true;
      }
    );
  });
});

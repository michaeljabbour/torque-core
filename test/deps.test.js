import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDependencyOrder } from '../kernel/resolver/deps.js';
import { CircularDependencyError } from '../kernel/errors.js';

const TMP = join(import.meta.dirname, '../.tmp-test-deps');

function writeManifest(name, manifest) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.yml'), `name: ${name}\n${manifest}`);
  return dir;
}

describe('resolveDependencyOrder()', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('returns bundles in topological order', () => {
    const dirs = {
      identity: writeManifest('identity', ''),
      pipeline: writeManifest('pipeline', 'depends_on:\n  - identity'),
      pulse: writeManifest('pulse', 'depends_on: []'),
    };
    const enabled = ['identity', 'pipeline', 'pulse'];
    const sorted = resolveDependencyOrder(dirs, enabled);
    const pipelineIdx = sorted.indexOf('pipeline');
    const identityIdx = sorted.indexOf('identity');
    assert.ok(identityIdx < pipelineIdx, 'identity must come before pipeline');
  });

  it('throws on missing hard dependency', () => {
    const dirs = {
      pipeline: writeManifest('pipeline', 'depends_on:\n  - identity'),
    };
    const enabled = ['pipeline'];
    assert.throws(
      () => resolveDependencyOrder(dirs, enabled),
      (err) => {
        assert.ok(err.message.includes('identity'));
        return true;
      }
    );
  });

  it('throws CircularDependencyError on circular deps', () => {
    const dirs = {
      a: writeManifest('a', 'depends_on:\n  - b'),
      b: writeManifest('b', 'depends_on:\n  - a'),
    };
    const enabled = ['a', 'b'];
    assert.throws(
      () => resolveDependencyOrder(dirs, enabled),
      (err) => {
        assert.equal(err.name, 'CircularDependencyError');
        assert.equal(err.code, 'CIRCULAR_DEPENDENCY');
        return true;
      }
    );
  });

  it('handles bundles with no dependencies', () => {
    const dirs = {
      a: writeManifest('a', ''),
      b: writeManifest('b', ''),
    };
    const enabled = ['a', 'b'];
    const sorted = resolveDependencyOrder(dirs, enabled);
    assert.equal(sorted.length, 2);
    assert.ok(sorted.includes('a'));
    assert.ok(sorted.includes('b'));
  });
});

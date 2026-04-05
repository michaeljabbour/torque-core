import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'fs';
import { readLock, writeLock, getLockEntry, setLockEntry, removeLockEntry } from '../kernel/resolver/lock.js';

describe('lock.js — flat format per spec §4.3', () => {
  afterEach(() => {
    if (existsSync('bundle.lock')) unlinkSync('bundle.lock');
  });

  it('readLock returns flat {} when no file exists', () => {
    const lock = readLock();
    assert.deepStrictEqual(lock, {});
    assert.equal(lock.resolved, undefined, 'should NOT have a resolved wrapper');
  });

  it('getLockEntry reads from flat structure', () => {
    const lock = {
      identity: {
        source: 'git+https://example.com/id.git@main',
        commit: 'abc123',
        resolved_at: '2026-01-01T00:00:00Z',
      },
    };
    const entry = getLockEntry(lock, 'identity');
    assert.equal(entry.source, 'git+https://example.com/id.git@main');
    assert.equal(entry.commit, 'abc123');
  });

  it('getLockEntry returns null for missing bundle', () => {
    assert.equal(getLockEntry({}, 'missing'), null);
  });

  it('setLockEntry writes flat with source, commit, resolved_at only', () => {
    const lock = {};
    setLockEntry(lock, 'pipeline', {
      source: 'git+https://example.com/pipe.git@v1',
      commit: 'def456',
      ref: 'v1',
    });
    assert.ok(lock.pipeline, 'entry should be at lock.pipeline, not lock.resolved.pipeline');
    assert.equal(lock.pipeline.source, 'git+https://example.com/pipe.git@v1');
    assert.equal(lock.pipeline.commit, 'def456');
    assert.ok(lock.pipeline.resolved_at, 'should have resolved_at timestamp');
    assert.equal(lock.pipeline.ref, undefined, 'should NOT store ref field');
  });

  it('removeLockEntry deletes from flat structure', () => {
    const lock = {
      identity: { source: 'x', commit: 'y', resolved_at: 'z' },
      pipeline: { source: 'a', commit: 'b', resolved_at: 'c' },
    };
    removeLockEntry(lock, 'identity');
    assert.equal(lock.identity, undefined);
    assert.ok(lock.pipeline, 'other entries should remain');
  });

  it('writeLock + readLock roundtrip produces flat YAML', () => {
    const lock = {};
    setLockEntry(lock, 'identity', {
      source: 'git+https://example.com/id.git@main',
      commit: 'abc123',
    });
    writeLock(lock);
    const reloaded = readLock();
    assert.ok(reloaded.identity, 'should be flat: reloaded.identity');
    assert.equal(reloaded.resolved, undefined, 'should NOT have resolved wrapper after roundtrip');
    assert.equal(reloaded.identity.commit, 'abc123');
  });
});

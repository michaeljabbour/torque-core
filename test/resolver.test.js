import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from '../kernel/resolver.js';

describe('Resolver.interpolateEnv()', () => {
  it('replaces ${VAR} with process.env value', () => {
    process.env.TEST_TORQUE_VAR = 'hello';
    const result = Resolver.interpolateEnv('value: ${TEST_TORQUE_VAR}');
    assert.equal(result, 'value: hello');
    delete process.env.TEST_TORQUE_VAR;
  });

  it('throws for missing required ${VAR}', () => {
    delete process.env.MISSING_VAR;
    assert.throws(
      () => Resolver.interpolateEnv('value: ${MISSING_VAR}'),
      (err) => {
        assert.ok(err.message.includes('MISSING_VAR'));
        return true;
      }
    );
  });

  it('returns empty string for optional ${?VAR}', () => {
    delete process.env.OPTIONAL_VAR;
    const result = Resolver.interpolateEnv('value: ${?OPTIONAL_VAR}');
    assert.equal(result, 'value: ');
  });

  it('replaces optional ${?VAR} when present', () => {
    process.env.TEST_OPTIONAL = 'present';
    const result = Resolver.interpolateEnv('value: ${?TEST_OPTIONAL}');
    assert.equal(result, 'value: present');
    delete process.env.TEST_OPTIONAL;
  });
});

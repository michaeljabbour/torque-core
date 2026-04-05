/**
 * Tests for typeValidator injection and call-time type validation.
 * Covers: constructor injection, input validation, output validation.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../kernel/registry.js';
import { ContractViolationError } from '../kernel/errors.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function createMockDataLayer() {
  return {
    schemas: {},
    registerSchema(bundleName, tables) { this.schemas[bundleName] = tables; },
    tablesFor(bundle) { return Object.keys(this.schemas[bundle] || {}); },
  };
}

function createMockEventBus() {
  return {
    _validationMode: 'warn',
    _declaredEvents: new Map(),
    setValidationMode(mode) { this._validationMode = mode; },
    registerDeclaredEvents(name, events) { this._declaredEvents.set(name, events); },
    registerEventSchemas() {},
    subscribers: new Map(),
    subscribe() {},
    subscriptions() { return {}; },
  };
}

/**
 * Mock typeValidator that does basic type checking.
 * Tracks all calls in fn.calls for assertions.
 */
function createMockTypeValidator() {
  const calls = [];
  const fn = (declaredType, actualValue, fieldName) => {
    calls.push({ declaredType, actualValue, fieldName });
    const checks = {
      string: (v) => typeof v === 'string',
      text: (v) => typeof v === 'string',
      uuid: (v) => typeof v === 'string' && /^[0-9a-f]{8}-/.test(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
    };
    const check = checks[declaredType];
    if (check && !check(actualValue)) {
      return `field '${fieldName}': expected ${declaredType}, got ${typeof actualValue}`;
    }
    return null;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Create a Registry with optional typeValidator, defaulting to strict mode
 * so violations throw (easier to assert in tests).
 */
function createTestRegistry(typeValidator = null, mode = 'strict') {
  const registry = new Registry({
    dataLayer: createMockDataLayer(),
    eventBus: createMockEventBus(),
    createScopedData: (dl, name) => ({ _bundle: name }),
    typeValidator,
  });
  registry._validationMode = mode;
  return registry;
}

/**
 * Register a test bundle + interface on a registry.
 * Lets you set input/output contracts and the handler in one call.
 *
 * Note: directly mutates registry.bundles and registry.interfaces (private state).
 * This is intentional test-only intrusion — the alternative would require loading
 * real manifest files, which is unnecessary overhead for unit tests.
 */
function registerTestInterface(registry, bundleName, interfaceName, { input, output, handler }) {
  if (!registry.bundles[bundleName]) {
    registry.bundles[bundleName] = { manifest: { interfaces: { contracts: {} } } };
  }
  const contract = {};
  if (input) contract.input = input;
  if (output) contract.output = output;
  registry.bundles[bundleName].manifest.interfaces.contracts[interfaceName] = contract;
  registry.interfaces[`${bundleName}.${interfaceName}`] = handler;
}

// ── Task 2: Constructor injection ─────────────────────────────────────────────

describe('Registry typeValidator injection', () => {
  it('stores typeValidator when provided', () => {
    const tv = createMockTypeValidator();
    const registry = createTestRegistry(tv);
    assert.equal(registry._typeValidator, tv);
  });

  it('defaults _typeValidator to null when not provided', () => {
    const registry = new Registry({
      dataLayer: createMockDataLayer(),
      eventBus: createMockEventBus(),
      createScopedData: (dl, name) => ({ _bundle: name }),
    });
    assert.equal(registry._typeValidator, null);
  });

  it('call() still works without typeValidator (backward compat)', async () => {
    const registry = createTestRegistry(); // no typeValidator
    registry.interfaces['test.greet'] = async ({ name }) => ({ greeting: `Hi ${name}` });
    const result = await registry.call('test', 'greet', { name: 'World' });
    assert.deepEqual(result, { greeting: 'Hi World' });
  });
});

// ── Task 3: Input validation ────────────────────────────────────────────────

describe('Registry input validation', () => {
  describe('required field checking', () => {
    it('throws when a required field is missing', async () => {
      const registry = createTestRegistry(createMockTypeValidator());
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
          userId: { type: 'uuid', required: true },
          description: { type: 'string' },
        },
        output: {},
        handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }),
      });

      await assert.rejects(
        () => registry.call('tasks', 'CreateTask', { taskName: 'Test' }),
        (err) => {
          assert.equal(err.name, 'ContractViolationError');
          assert.ok(err.message.includes('userId'), `should mention missing field 'userId', got: ${err.message}`);
          assert.ok(err.message.includes('required'), `should mention 'required', got: ${err.message}`);
          return true;
        }
      );
    });

    it('throws when a required field is null', async () => {
      const registry = createTestRegistry(createMockTypeValidator());
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
        },
        output: {},
        handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }),
      });

      await assert.rejects(
        () => registry.call('tasks', 'CreateTask', { taskName: null }),
        (err) => {
          assert.equal(err.name, 'ContractViolationError');
          assert.ok(err.message.includes('taskName'));
          return true;
        }
      );
    });

    it('passes when all required fields are present', async () => {
      const registry = createTestRegistry(createMockTypeValidator());
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
          userId: { type: 'uuid', required: true },
        },
        output: {},
        handler: async (args) => ({ id: '550e8400-e29b-41d4-a716-446655440000', ...args }),
      });

      const result = await registry.call('tasks', 'CreateTask', {
        taskName: 'Test',
        userId: '550e8400-e29b-41d4-a716-446655440000',
      });
      assert.ok(result.id);
    });

    it('skips validation when no input contract is declared', async () => {
      const registry = createTestRegistry(createMockTypeValidator());
      registerTestInterface(registry, 'tasks', 'ListTasks', {
        output: {},
        handler: async () => ([]),
      });

      const result = await registry.call('tasks', 'ListTasks', { anything: 'goes' });
      assert.deepEqual(result, []);
    });
  });

  describe('input type checking', () => {
    it('throws when input field has wrong type', async () => {
      const registry = createTestRegistry(createMockTypeValidator());
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
          priority: { type: 'integer' },
        },
        output: {},
        handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }),
      });

      await assert.rejects(
        () => registry.call('tasks', 'CreateTask', { taskName: 'Test', priority: 'high' }),
        (err) => {
          assert.equal(err.name, 'ContractViolationError');
          assert.ok(err.message.includes('priority'), `should mention field 'priority', got: ${err.message}`);
          assert.ok(err.message.includes('integer'), `should mention expected type, got: ${err.message}`);
          return true;
        }
      );
    });

    it('passes when input field types are correct', async () => {
      const tv = createMockTypeValidator();
      const registry = createTestRegistry(tv);
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
          priority: { type: 'integer' },
        },
        output: {},
        handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }),
      });

      await registry.call('tasks', 'CreateTask', { taskName: 'Test', priority: 3 });
      // typeValidator should have been called for both fields
      assert.ok(tv.calls.length >= 2, `typeValidator should be called for present fields, got ${tv.calls.length} calls`);
    });

    it('skips type check for undefined (optional) fields', async () => {
      const tv = createMockTypeValidator();
      const registry = createTestRegistry(tv);
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
          description: { type: 'string' },  // optional, not passed
        },
        output: {},
        handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }),
      });

      await registry.call('tasks', 'CreateTask', { taskName: 'Test' });
      // typeValidator should NOT be called for 'description' (absent)
      const descCalls = tv.calls.filter(c => c.fieldName === 'description');
      assert.equal(descCalls.length, 0, 'should not type-check absent optional fields');
    });

    it('skips all input validation when no typeValidator is provided', async () => {
      const registry = createTestRegistry(null); // no typeValidator
      registerTestInterface(registry, 'tasks', 'CreateTask', {
        input: {
          taskName: { type: 'string', required: true },
        },
        output: {},
        handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }),
      });

      // Missing required field, but no typeValidator = no validation = no error
      const result = await registry.call('tasks', 'CreateTask', {});
      assert.ok(result.id);
    });
  });
});

// ── Task 4: Output type validation ──────────────────────────────────────────────

describe('Registry output type validation', () => {
  it('throws when output field has wrong type', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({ id: 42, title: 'Test' }),  // id should be uuid string, not number
    });

    await assert.rejects(
      () => registry.call('tasks', 'GetTask', {}),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('id'), `should mention field 'id', got: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when output field types are correct', async () => {
    const tv = createMockTypeValidator();
    const registry = createTestRegistry(tv);
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Test' }),
    });

    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result.title, 'Test');
    // typeValidator should have been called for both output fields
    assert.ok(tv.calls.length >= 2, `typeValidator should check output fields, got ${tv.calls.length} calls`);
  });

  it('skips output type checking when typeValidator is null', async () => {
    const registry = createTestRegistry(null); // no typeValidator
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({ id: 42, title: 'Test' }), // wrong type but no validator
    });

    // Should NOT throw -- existing field presence check passes (id is present), type check skipped
    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result.id, 42);
  });

  it('still checks field presence (existing behavior) alongside type checking', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string', status: 'string' },
      },
      handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Test' }), // missing 'status'
    });

    await assert.rejects(
      () => registry.call('tasks', 'GetTask', {}),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('status'), `should mention missing field 'status', got: ${err.message}`);
        return true;
      }
    );
  });

  it('does not type-check fields that are undefined in result', async () => {
    const tv = createMockTypeValidator();
    const registry = createTestRegistry(tv, 'warn'); // warn mode so missing field doesn't throw
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }), // title missing
    });

    await registry.call('tasks', 'GetTask', {});
    // typeValidator should NOT be called for 'title' (undefined in result)
    const titleCalls = tv.calls.filter(c => c.fieldName === 'title');
    assert.equal(titleCalls.length, 0, 'should not type-check undefined output fields');
  });
});

// ── Task 5: Output array validation ─────────────────────────────────────────────

describe('Registry output array validation', () => {
  it('throws when output.type is array but handler returns non-array', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'ListTasks', {
      output: {
        type: 'array',
        items: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({ id: '550e8400-e29b-41d4-a716-446655440000' }), // object, not array
    });

    await assert.rejects(
      () => registry.call('tasks', 'ListTasks', {}),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('array'), `should mention 'array', got: ${err.message}`);
        return true;
      }
    );
  });

  it('validates each item in the array against items shape', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'ListTasks', {
      output: {
        type: 'array',
        items: { id: 'uuid', title: 'string' },
      },
      handler: async () => ([
        { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Task 1' },
        { id: 42, title: 'Task 2' }, // id is wrong type
      ]),
    });

    await assert.rejects(
      () => registry.call('tasks', 'ListTasks', {}),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('[1]'), `should include item index, got: ${err.message}`);
        assert.ok(err.message.includes('id'), `should mention field 'id', got: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when all array items match the schema', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'ListTasks', {
      output: {
        type: 'array',
        items: { id: 'uuid', title: 'string' },
      },
      handler: async () => ([
        { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Task 1' },
        { id: '660e8400-e29b-41d4-a716-446655440000', title: 'Task 2' },
      ]),
    });

    const result = await registry.call('tasks', 'ListTasks', {});
    assert.equal(result.length, 2);
  });

  it('passes empty array without error', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'ListTasks', {
      output: {
        type: 'array',
        items: { id: 'uuid', title: 'string' },
      },
      handler: async () => ([]),
    });

    const result = await registry.call('tasks', 'ListTasks', {});
    assert.deepEqual(result, []);
  });

  it('skips array validation when no typeValidator', async () => {
    const registry = createTestRegistry(null);
    registerTestInterface(registry, 'tasks', 'ListTasks', {
      output: {
        type: 'array',
        items: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({ notAnArray: true }), // wrong but no validator
    });

    const result = await registry.call('tasks', 'ListTasks', {});
    assert.equal(result.notAnArray, true);
  });
});

// ── Task 6: Output extra field detection ────────────────────────────────────

describe('Registry output extra field detection', () => {
  it('throws when result has fields not declared in output.shape', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test',
        secret: 'should-not-be-here',  // undeclared field
      }),
    });

    await assert.rejects(
      () => registry.call('tasks', 'GetTask', {}),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('secret'), `should mention undeclared field 'secret', got: ${err.message}`);
        assert.ok(err.message.includes('undeclared'), `should mention 'undeclared', got: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when result has only declared fields', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid', title: 'string' },
      },
      handler: async () => ({
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test',
      }),
    });

    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result.title, 'Test');
  });

  it('skips extra field check when no typeValidator', async () => {
    const registry = createTestRegistry(null);
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid' },
      },
      handler: async () => ({
        id: '550e8400-e29b-41d4-a716-446655440000',
        extra: 'not-declared',
      }),
    });

    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result.extra, 'not-declared');
  });
});

// ── Task 7: Output nullable enforcement ─────────────────────────────────────

describe('Registry output nullable enforcement', () => {
  it('throws when handler returns null and output.nullable is false', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        nullable: false,
        shape: { id: 'uuid' },
      },
      handler: async () => null,
    });

    await assert.rejects(
      () => registry.call('tasks', 'GetTask', {}),
      (err) => {
        assert.equal(err.name, 'ContractViolationError');
        assert.ok(err.message.includes('null'), `should mention 'null', got: ${err.message}`);
        return true;
      }
    );
  });

  it('passes when handler returns null and nullable is not declared (default)', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        shape: { id: 'uuid' },
      },
      handler: async () => null,
    });

    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result, null);
  });

  it('passes when handler returns null and output.nullable is true', async () => {
    const registry = createTestRegistry(createMockTypeValidator());
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        nullable: true,
        shape: { id: 'uuid' },
      },
      handler: async () => null,
    });

    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result, null);
  });

  it('skips nullable check when no typeValidator', async () => {
    const registry = createTestRegistry(null);
    registerTestInterface(registry, 'tasks', 'GetTask', {
      output: {
        nullable: false,
        shape: { id: 'uuid' },
      },
      handler: async () => null,
    });

    const result = await registry.call('tasks', 'GetTask', {});
    assert.equal(result, null);
  });
});

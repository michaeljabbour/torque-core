import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRuntime } from '../idd/claude-runtime.js';
import { Intent } from '../idd/Intent.js';
import { Behavior } from '../idd/Behavior.js';
import { Context } from '../idd/Context.js';

describe('ClaudeRuntime', () => {
  describe('buildSystemPrompt()', () => {
    it('includes intent name, description, criteria, and persona', () => {
      const runtime = new ClaudeRuntime({ sdk: null });
      const intent = new Intent({
        name: 'SendEmail',
        description: 'Send an email to a recipient',
        successCriteria: ['Email is delivered', 'Recipient is notified'],
        behavior: new Behavior({ persona: 'You are a helpful email assistant.' }),
      });
      const prompt = runtime.buildSystemPrompt({ intent, context: [] });

      assert.ok(prompt.includes('SendEmail'), 'should include intent name');
      assert.ok(prompt.includes('Send an email to a recipient'), 'should include intent description');
      assert.ok(prompt.includes('Email is delivered'), 'should include first success criterion');
      assert.ok(prompt.includes('Recipient is notified'), 'should include all success criteria');
      assert.ok(prompt.includes('You are a helpful email assistant.'), 'should include behavior persona');
    });

    it('includes context schema info', () => {
      const runtime = new ClaudeRuntime({ sdk: null });
      const intent = new Intent({
        name: 'SearchContacts',
        description: 'Search for contacts',
        successCriteria: [],
        behavior: new Behavior({}),
      });
      const context = [
        new Context('Contact', {
          schema: {
            id: { type: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string' },
          },
          vectorize: ['name', 'email'],
        }),
      ];
      const prompt = runtime.buildSystemPrompt({ intent, context });

      assert.ok(prompt.includes('Contact'), 'should include context name');
      assert.ok(prompt.includes('id'), 'should include id field');
      assert.ok(prompt.includes('name'), 'should include name field');
      assert.ok(prompt.includes('email'), 'should include email field');
      assert.ok(
        prompt.includes('Semantic/vectorized fields: name, email'),
        'should include vectorized fields line'
      );
    });
  });

  describe('buildToolSchemas()', () => {
    it('converts interfaces to tool-call format with required fields', () => {
      const runtime = new ClaudeRuntime({ sdk: null });
      const interfaces = [
        {
          bundle: 'email',
          name: 'sendEmail',
          description: 'Send an email',
          input: [
            { name: 'to', type: 'string', required: true },
            { name: 'subject', type: 'string', required: true },
            { name: 'body', type: 'string', required: false },
          ],
        },
      ];

      const schemas = runtime.buildToolSchemas(interfaces);

      assert.equal(schemas.length, 1);
      const schema = schemas[0];
      assert.equal(schema.name, 'email__sendEmail');
      assert.equal(schema.description, 'Send an email');
      assert.equal(schema.input_schema.type, 'object');
      assert.ok(schema.input_schema.properties.to, 'should have to property');
      assert.ok(schema.input_schema.properties.subject, 'should have subject property');
      assert.ok(schema.input_schema.properties.body, 'should have body property');
      assert.ok(schema.input_schema.required.includes('to'), 'to should be required');
      assert.ok(schema.input_schema.required.includes('subject'), 'subject should be required');
      assert.ok(!schema.input_schema.required.includes('body'), 'body should not be required');
    });
  });

  describe('execute()', () => {
    it('throws with /claude-agent-sdk/ message when SDK is null', async () => {
      const runtime = new ClaudeRuntime({ sdk: null });
      const intent = new Intent({ name: 'Test', description: 'test', successCriteria: [] });

      await assert.rejects(
        () => runtime.execute(intent, [], [], {}),
        (err) => {
          assert.match(err.message, /claude-agent-sdk/);
          return true;
        }
      );
    });

    it('calls mock SDK and returns { status, output, trace }', async () => {
      async function* mockQuery() {
        yield { type: 'text', text: 'Hello from Claude', timestamp: new Date().toISOString() };
      }

      const mockSdk = { query: mockQuery };
      const runtime = new ClaudeRuntime({ sdk: mockSdk });

      const savedKey = process.env.ANTHROPIC_API_KEY;
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key';

        const intent = new Intent({
          name: 'Test',
          description: 'test',
          successCriteria: [],
          behavior: new Behavior({}),
        });

        const result = await runtime.execute(intent, [], [], {
          toolExecutor: async () => ({}),
        });

        assert.equal(result.status, 'success');
        assert.ok(typeof result.output === 'string', 'output should be a string');
        assert.ok(Array.isArray(result.trace), 'trace should be an array');
      } finally {
        if (savedKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = savedKey;
        }
      }
    });
  });
});

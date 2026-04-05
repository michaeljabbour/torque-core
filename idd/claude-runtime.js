/**
 * ClaudeRuntime
 * Wraps @anthropic-ai/claude-agent-sdk and implements execute(intent, context, tools).
 * The SDK is an optional peer dependency — if not installed, create() returns sdk=null
 * and execute() throws a clear error.
 */
export class ClaudeRuntime {
  /**
   * @param {object} param0
   * @param {object|null} param0.sdk - The @anthropic-ai/claude-agent-sdk module, or null
   */
  constructor({ sdk }) {
    this._sdk = sdk;
  }

  /**
   * Dynamically imports @anthropic-ai/claude-agent-sdk.
   * Returns a ClaudeRuntime with sdk=null if the package is not installed.
   * @returns {Promise<ClaudeRuntime>}
   */
  static async create() {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      return new ClaudeRuntime({ sdk });
    } catch {
      return new ClaudeRuntime({ sdk: null });
    }
  }

  /**
   * Builds a system prompt from Intent, Behavior, and Context.
   * @param {object} param0
   * @param {import('./Intent.js').Intent} param0.intent
   * @param {import('./Context.js').Context[]} param0.context
   * @returns {string}
   */
  buildSystemPrompt({ intent, context }) {
    const behavior = intent.behavior;
    const persona = behavior
      ? behavior.persona
      : 'You are an objective, precise, and helpful system agent.';

    const lines = [];

    // Behavior persona
    lines.push('## Persona');
    lines.push(persona);
    lines.push('');

    // Intent name and description
    lines.push('## Intent');
    lines.push(`Name: ${intent.name}`);
    lines.push(`Description: ${intent.description}`);
    lines.push('');

    // Success criteria as bullet list
    if (intent.successCriteria && intent.successCriteria.length > 0) {
      lines.push('## Success Criteria');
      for (const criterion of intent.successCriteria) {
        lines.push(`- ${criterion}`);
      }
      lines.push('');
    }

    // Context schemas with field listings and vectorize fields
    if (context && context.length > 0) {
      lines.push('## Context');
      for (const ctx of context) {
        lines.push(`### ${ctx.name}`);
        if (ctx.schema && Object.keys(ctx.schema).length > 0) {
          lines.push('Fields:');
          for (const [field, meta] of Object.entries(ctx.schema)) {
            const type = meta && meta.type ? meta.type : 'unknown';
            lines.push(`  - ${field}: ${type}`);
          }
        }
        if (ctx.vectorize && ctx.vectorize.length > 0) {
          lines.push(`Semantic/vectorized fields: ${ctx.vectorize.join(', ')}`);
        }
        lines.push('');
      }
    }

    // Human confirmation requirements
    if (
      behavior &&
      behavior.requireHumanConfirmation &&
      behavior.requireHumanConfirmation.length > 0
    ) {
      lines.push('## Human Confirmation Required');
      for (const tool of behavior.requireHumanConfirmation) {
        lines.push(`- ${tool}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Converts interface declarations to Claude tool schema format.
   * @param {Array<{ bundle: string, name: string, description: string, input: Array<{ name: string, type: string, required: boolean, description?: string }> }>} interfaces
   * @returns {Array<{ name: string, description: string, input_schema: object }>}
   */
  buildToolSchemas(interfaces) {
    return interfaces.map((iface) => {
      const properties = {};
      const required = [];

      for (const field of iface.input || []) {
        properties[field.name] = { type: ClaudeRuntime._mapType(field.type) };
        if (field.description) {
          properties[field.name].description = field.description;
        }
        if (field.required) {
          required.push(field.name);
        }
      }

      return {
        name: `${iface.bundle}__${iface.name}`,
        description: iface.description,
        input_schema: {
          type: 'object',
          properties,
          required,
        },
      };
    });
  }

  /**
   * Maps Torque types to JSON Schema types.
   * @param {string} type
   * @returns {string}
   */
  static _mapType(type) {
    switch (type) {
      case 'string':
      case 'uuid':
        return 'string';
      case 'integer':
        return 'integer';
      case 'float':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'timestamp':
        return 'string';
      case 'object':
        return 'object';
      case 'array':
        return 'array';
      default:
        return 'string';
    }
  }

  /**
   * Executes an intent using the Claude SDK.
   * @param {import('./Intent.js').Intent} intent
   * @param {import('./Context.js').Context[]} context
   * @param {Array} tools - Interface declarations
   * @param {object} [opts]
   * @param {Function} [opts.toolExecutor] - Called with (bundle, iface, input) for tool_use events
   * @returns {Promise<{ status: string, output: string, trace: Array }>}
   */
  async execute(intent, context, tools, opts = {}) {
    if (!this._sdk) {
      throw new Error(
        '@anthropic-ai/claude-agent-sdk is not installed. ' +
          'Install it as a peer dependency to use ClaudeRuntime.'
      );
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is required to use ClaudeRuntime.'
      );
    }

    const systemPrompt = this.buildSystemPrompt({ intent, context });
    const toolSchemas = this.buildToolSchemas(tools);

    const trace = [];
    const outputs = [];

    const generator = this._sdk.query({
      systemPrompt,
      tools: toolSchemas,
    });

    for await (const event of generator) {
      trace.push({
        type: event.type,
        timestamp: event.timestamp || new Date().toISOString(),
      });

      if (event.type === 'text') {
        outputs.push(event.text);
      } else if (event.type === 'tool_use') {
        // Tool name format: bundle__ifaceName
        const doubleUnderscoreIdx = event.name.indexOf('__');
        if (doubleUnderscoreIdx === -1) continue; // not a torque tool name
        const bundle = event.name.slice(0, doubleUnderscoreIdx);
        const name = event.name.slice(doubleUnderscoreIdx + 2);

        const iface = tools.find((t) => t.bundle === bundle && t.name === name);

        if (opts.toolExecutor && iface) {
          await opts.toolExecutor(bundle, iface, event.input);
        }
      }
    }

    return {
      status: 'success',
      output: outputs.join('\n'),
      trace,
    };
  }
}

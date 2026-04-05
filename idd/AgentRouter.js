import { AgentCoordinator } from './AgentCoordinator.js';

/**
 * AgentRouter
 * Unifies Intents and Routes execution.
 * Orchestrates: resolve intent → build context → call runtime → handle tool calls → emit lifecycle events.
 */
export class AgentRouter {
  /**
   * @param {object} param0
   * @param {object} param0.registry - The kernel Registry instance
   * @param {object} param0.runtime  - Runtime with an execute() method (e.g. ClaudeRuntime)
   * @param {object} param0.hookBus  - HookBus for lifecycle events
   * @param {object|null} [param0.embeddingService] - Optional embedding service (unused internally, stored for consumers)
   */
  constructor({ registry, runtime, hookBus, embeddingService = null }) {
    this._registry = registry;
    this._runtime = runtime;
    this._hookBus = hookBus;
    this._embeddingService = embeddingService;
  }

  /**
   * @deprecated Use `new AgentRouter(options)` directly.
   * @param {object} options
   * @returns {AgentRouter}
   */
  static create(options) {
    return new AgentRouter(options);
  }

  /**
   * Build tool declarations from an intent's behavior.allowedTools.
   * Each entry in allowedTools is "bundleName.interfaceName".
   * Resolves contract description and input from the bundle manifest.
   *
   * @param {object} intent
   * @returns {Array<{ bundle: string, name: string, description: string, input: Array }>}
   */
  _resolveTools(intent) {
    const allowedTools = intent.behavior?.allowedTools ?? [];
    return allowedTools.map((tool) => {
      const dotIdx = tool.indexOf('.');
      const bundle = tool.slice(0, dotIdx);
      const iface = tool.slice(dotIdx + 1);
      const contract =
        this._registry.bundles[bundle]?.manifest?.interfaces?.contracts?.[iface] ?? {};
      return {
        bundle,
        name: iface,
        description: contract.description ?? '',
        input: contract.input ?? [],
      };
    });
  }

  /**
   * Build context data from a bundle's manifest schema tables.
   * Returns an array of { name, schema } objects for each table.
   *
   * @param {string} bundleName
   * @returns {Array<{ name: string, schema: object }>}
   */
  _resolveContext(bundleName) {
    const bundle = this._registry.bundles[bundleName];
    const tables = bundle?.manifest?.schema?.tables ?? {};
    const contextData = [];
    for (const [tableName, columns] of Object.entries(tables)) {
      const schema = {};
      for (const [colName, colDef] of Object.entries(columns)) {
        schema[colName] = { type: colDef?.type ?? 'string' };
      }
      contextData.push({ name: tableName, schema });
    }
    return contextData;
  }

  /**
   * Execute an intent orchestration loop.
   *
   * @param {string} bundleName  - The bundle that owns the intent
   * @param {string} intentName  - Key under bundle.intents
   * @param {object} input       - Arbitrary input payload
   * @returns {Promise<{ status: string, output: any, trace: Array }>}
   */
  async execute(bundleName, intentName, input) {
    // 1. Resolve intent
    const intent = this._registry.bundles[bundleName]?.intents?.[intentName];
    if (!intent) {
      throw new Error(`Intent '${intentName}' not found in bundle '${bundleName}'`);
    }

    // 2. Emit idd:intent_received
    if (this._hookBus) {
      this._hookBus.emitSync('idd:intent_received', { bundle: bundleName, intent, input });
    }

    // 3. Build tool declarations
    const toolDeclarations = this._resolveTools(intent);
    const allowedTools = intent.behavior?.allowedTools ?? [];

    // 4. Build context
    const contextData = this._resolveContext(bundleName);

    // 5. Create scoped AgentCoordinator
    const coordinator = new AgentCoordinator(this._registry, allowedTools);

    // 6. Emit idd:executing
    if (this._hookBus) {
      this._hookBus.emitSync('idd:executing', {
        bundle: bundleName,
        intent,
        toolCount: toolDeclarations.length,
      });
    }

    // 7a. Build tool executor: delegates calls through the coordinator
    const toolExecutor = async (bundle, iface, args) => {
      // runtime may pass an interface object or a plain string; normalise to string
      const ifaceName = typeof iface === 'string' ? iface : iface.name;
      return coordinator.call(bundle, ifaceName, args);
    };

    try {
      // 7b. Call runtime
      const result = await this._runtime.execute(intent, contextData, toolDeclarations, {
        toolExecutor,
        maxTurns: 10,
      });

      // 8. On success
      if (this._hookBus) {
        this._hookBus.emitSync('idd:resolved', {
          bundle: bundleName,
          intent,
          status: result.status,
          traceLength: (result.trace ?? []).length,
        });
      }

      return result;
    } catch (error) {
      // 9. On error
      if (this._hookBus) {
        this._hookBus.emitSync('idd:failed', { bundle: bundleName, intent, error });
      }

      return { status: 'failed', output: null, error, trace: [] };
    }
  }
}

/**
 * HookBus — Lifecycle hook system for the Torque kernel.
 *
 * Hooks are code-decided observers (not LLM-decided like events).
 * They fire at defined kernel lifecycle points and can be used for:
 * - Audit logging
 * - Distributed tracing
 * - Rate limiting
 * - Performance monitoring
 * - Auth enforcement (via gates)
 *
 * Hook positions:
 *   bundle:before-boot / bundle:after-boot
 *   interface:before-call / interface:after-call / interface:error
 *   event:before-publish / event:after-publish
 *
 * Gate positions (can abort the operation):
 *   interface:gate — runs before interface:before-call, can reject
 */
export class HookBus {
  constructor() {
    this.hooks = new Map();
    this.gates = new Map();
  }

  /**
   * Register a hook handler for a lifecycle position.
   * Hooks are observers — errors are logged but don't interrupt the caller.
   * @param {string} position - Hook position (e.g., 'interface:before-call')
   * @param {Function} handler - Async or sync handler function
   * @param {object} [opts]
   * @param {string} [opts.name] - Hook name for logging
   */
  on(position, handler, { name = 'anonymous' } = {}) {
    if (!this.hooks.has(position)) this.hooks.set(position, []);
    this.hooks.get(position).push({ handler, name });
  }

  /**
   * Register a gate handler. Gates differ from hooks:
   * - Gates run BEFORE hooks at the same position
   * - Gates CAN abort the operation by throwing
   * - Gate errors are NOT swallowed — they propagate to the caller
   *
   * Use for authorization, rate limiting, or any pre-call validation
   * that should block the operation on failure.
   *
   * @param {string} position - Gate position (e.g., 'interface:gate')
   * @param {Function} handler - (context) => void. Throw to reject.
   * @param {object} [opts]
   * @param {string} [opts.name] - Gate name for logging/introspection
   */
  gate(position, handler, { name = 'anonymous' } = {}) {
    if (!this.gates.has(position)) this.gates.set(position, []);
    this.gates.get(position).push({ handler, name });
  }

  /**
   * Run gate handlers for a position. Unlike hooks, gate errors propagate.
   * All gates must pass (no throw) for the operation to proceed.
   * @param {string} position - Gate position
   * @param {object} context - Context data for the gate
   * @throws {Error} If any gate rejects the operation
   */
  runGate(position, context) {
    const gates = this.gates.get(position) || [];
    for (const { handler, name } of gates) {
      handler(context); // errors propagate intentionally
    }
  }

  /**
   * Emit a hook event. All registered handlers are called in order.
   * Errors in hooks are logged but don't interrupt the caller.
   * @param {string} position - Hook position
   * @param {object} context - Context data for the hook
   */
  async emit(position, context) {
    const handlers = this.hooks.get(position) || [];
    for (const { handler, name } of handlers) {
      try {
        await handler(context);
      } catch (e) {
        console.warn(`[hooks] Hook '${name}' failed at '${position}': ${e.message}`);
      }
    }
  }

  /**
   * Synchronous emit for performance-critical paths.
   */
  emitSync(position, context) {
    const handlers = this.hooks.get(position) || [];
    for (const { handler, name } of handlers) {
      try {
        handler(context);
      } catch (e) {
        console.warn(`[hooks] Hook '${name}' failed at '${position}': ${e.message}`);
      }
    }
  }

  /**
   * List all registered hook and gate positions and their handler names.
   */
  summary() {
    const result = {};
    for (const [position, handlers] of this.hooks) {
      result[position] = handlers.map(h => h.name);
    }
    for (const [position, handlers] of this.gates) {
      const key = `${position} (gate)`;
      result[key] = handlers.map(h => h.name);
    }
    return result;
  }
}

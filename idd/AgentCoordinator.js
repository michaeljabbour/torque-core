/**
 * AgentCoordinator
 * Wraps registry.call() with Behavior.allowedTools enforcement.
 * Used by AgentRouter to scope tool execution to the declared intent behavior.
 */
export class AgentCoordinator {
  /**
   * @param {object} registry - The kernel Registry instance (must have a .call() method)
   * @param {string[]} allowedTools - Array of "bundle.interfaceName" strings that are permitted
   */
  constructor(registry, allowedTools) {
    this._registry = registry;
    this._allowed = new Set(allowedTools);
  }

  /**
   * Call an interface on a bundle.
   * Checks the "bundle.interfaceName" key against the allowed set before delegating.
   *
   * @param {string} bundle - Bundle name
   * @param {string} interfaceName - Interface name
   * @param {object} [args={}] - Arguments to pass
   * @returns {Promise<any>}
   * @throws {Error} If the tool is not in the allowed set
   */
  async call(bundle, interfaceName, args = {}) {
    const key = `${bundle}.${interfaceName}`;
    if (!this._allowed.has(key)) {
      throw new Error(`Tool '${key}' is not allowed by this intent's behavior`);
    }
    return this._registry.call(bundle, interfaceName, args);
  }
}

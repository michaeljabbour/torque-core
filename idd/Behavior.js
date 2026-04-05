/**
 * Behavior Primitive
 * Represents the "How" — execution constraints, allowed tools, and human-in-the-loop rules.
 */
export class Behavior {
  /**
   * @param {object} param0
   * @param {string} [param0.persona] - Instructions to the agent on tone and style
   * @param {string[]} [param0.allowedTools] - List of registered tools/interfaces the agent can call
   * @param {string[]} [param0.requireHumanConfirmation] - Tools that pause execution and demand UI confirmation
   */
  constructor({ persona, allowedTools, requireHumanConfirmation }) {
    this.persona = persona || 'You are an objective, precise, and helpful system agent.';
    this.allowedTools = allowedTools || [];
    this.requireHumanConfirmation = requireHumanConfirmation || [];
  }

  toJSON() {
    return {
      persona: this.persona,
      allowedTools: this.allowedTools,
      requireHumanConfirmation: this.requireHumanConfirmation
    };
  }
}

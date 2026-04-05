/**
 * Intent Primitive
 * Represents the "Why" — the goal, success criteria, and trigger.
 */
export class Intent {
  /**
   * @param {object} param0
   * @param {string} param0.name - Unique identifier for the intent
   * @param {string} param0.description - High-level purpose of the intent
   * @param {string|function} [param0.trigger] - When this intent should activate
   * @param {string[]} param0.successCriteria - What "done" looks like
   * @param {import('./Behavior.js').Behavior} [param0.behavior] - The Behavior binding for this intent
   */
  constructor({ name, description, trigger, successCriteria, behavior }) {
    this.name = name;
    this.description = description;
    this.trigger = trigger;
    this.successCriteria = successCriteria || [];
    this.behavior = behavior || null;
  }

  useBehavior(behavior) {
    this.behavior = behavior;
    return this;
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      trigger: this.trigger,
      successCriteria: this.successCriteria,
      behavior: this.behavior ? this.behavior.toJSON() : null
    };
  }
}

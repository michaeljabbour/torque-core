/**
 * Context Primitive
 * Represents the "What" — Memory, State, and semantic boundaries.
 */
export class Context {
  /**
   * @param {string} name - Entity or topic name
   * @param {object} param1
   * @param {object} param1.schema - VORM / standard data schema
   * @param {string[]} [param1.vectorize] - Fields that should be semantically indexed
   */
  constructor(name, { schema, vectorize }) {
    this.name = name;
    this.schema = schema || {};
    this.vectorize = vectorize || [];
  }

  toJSON() {
    return {
      name: this.name,
      schema: this.schema,
      vectorize: this.vectorize
    };
  }
}

/**
 * Behavior validation for the torque resolver.
 *
 * Behaviors are cross-cutting capability definitions expressed as YAML files
 * that are merged into bundle manifests at resolve time. They provide shared
 * hooks, gates, events, config, and other capabilities across bundles.
 *
 * NOTE: This module is completely separate from torque-core/idd/Behavior.js,
 * which deals with instance-level behavior objects in the IDD system.
 */

const ALLOWED_KEYS = new Set([
  'name',
  'version',
  'description',
  'extensions',
  'hooks',
  'gates',
  'events',
  'config',
  'permissions',
  'jobs',
  'context',
  'agents',
]);

const FORBIDDEN_KEYS = new Set([
  'schema',
  'routes',
  'interfaces',
  'intents',
  'ui',
  'logic',
]);

/**
 * Validates a behavior definition object.
 *
 * @param {object} behavior - The behavior definition to validate.
 * @throws {Error} If the behavior is missing a name, contains forbidden keys,
 *   or includes forbidden nested keys such as events.publishes.
 */
export function validateBehavior(behavior) {
  if (!behavior.name) {
    throw new Error('Behavior is missing required field: name');
  }

  for (const key of Object.keys(behavior)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(
        `Behavior "${behavior.name}" contains forbidden key: ${key}`
      );
    }
  }

  if (behavior.events?.publishes !== undefined) {
    throw new Error(
      `Behavior "${behavior.name}" contains forbidden nested key: events.publishes`
    );
  }
}

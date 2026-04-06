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
 * Normalizes a subscribe entry to a string.
 *
 * @param {string|{event: string}} entry - The subscribe entry to normalize.
 * @returns {string} The normalized event name.
 * @throws {Error} If the entry is not a string or an object with an event property.
 */
function normalizeSubscribeEntry(entry) {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry !== null && typeof entry === 'object' && typeof entry.event === 'string') {
    return entry.event;
  }
  throw new Error('Invalid subscribe entry');
}

/**
 * Expands wildcard subscribe patterns against a bundle's published event list.
 *
 * @param {Array<string|{event: string}>} subscribes - The list of subscribe entries.
 * @param {Array<string|{name: string}>} bundlePublishes - The list of published events.
 * @returns {{expanded: string[], warnings: string[]}} The expanded events and warnings.
 */
export function expandEventWildcards(subscribes, bundlePublishes) {
  const expanded = [];
  const warnings = [];
  const seen = new Set();

  for (const rawEntry of subscribes) {
    const entry = normalizeSubscribeEntry(rawEntry);

    if (!entry.includes('*')) {
      if (!seen.has(entry)) {
        seen.add(entry);
        expanded.push(entry);
      }
    } else {
      const suffix = entry.replace('*', '');
      let matchCount = 0;

      for (const pub of bundlePublishes) {
        const eventName = typeof pub === 'string' ? pub : pub.name;
        if (eventName.endsWith(suffix)) {
          matchCount++;
          if (!seen.has(eventName)) {
            seen.add(eventName);
            expanded.push(eventName);
          }
        }
      }

      if (matchCount === 0) {
        warnings.push(`${entry} matched 0 events`);
      }
    }
  }

  return { expanded, warnings };
}

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

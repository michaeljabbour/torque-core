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

const FORBIDDEN_KEYS = new Set([
  'schema',
  'routes',
  'interfaces',
  'intents',
  'ui',
  'logic',
]);

/**
 * Returns whether a value is a plain object (not an array, Date, null, etc.)
 *
 * @param {*} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merges source defaults into target, returning a new object.
 * Target wins on conflict. Recursion only into nested plain objects.
 * Source values are defaults (used when target lacks the key).
 *
 * @param {*} target - The value that wins on conflict.
 * @param {*} source - The default values.
 * @returns {*} Merged result.
 */
function deepMergeDefaults(target, source) {
  if (!isPlainObject(source) || !isPlainObject(target)) {
    // Non-plain-object case: target wins if defined, else use source
    return target !== undefined ? target : source;
  }
  // Both are plain objects — merge them
  const result = {};
  // Start with all source keys (defaults)
  for (const [k, v] of Object.entries(source)) {
    result[k] = v;
  }
  // Apply target values, overriding source defaults
  for (const [k, v] of Object.entries(target)) {
    if (isPlainObject(v) && isPlainObject(result[k])) {
      result[k] = deepMergeDefaults(v, result[k]);
    } else {
      result[k] = v; // target wins
    }
  }
  return result;
}

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
      // Replace only the first '*' — patterns with multiple wildcards are not supported
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

/**
 * Resolves an array of behaviors into a bundle manifest, applying each
 * behavior's merge rules in order and returning the enriched manifest,
 * collected warnings, and delta counts.
 *
 * @param {object} manifest - The bundle manifest to enrich.
 * @param {object[]} behaviors - Ordered list of behavior definitions.
 * @returns {{ manifest: object, warnings: string[], deltas: object }}
 */
export function resolveBehaviors(manifest, behaviors) {
  // Early return for empty behaviors — manifest is unchanged
  if (!behaviors || behaviors.length === 0) {
    return {
      manifest,
      warnings: [],
      deltas: {
        extensions: 0,
        hooks: 0,
        gates: 0,
        event_subscriptions: 0,
        jobs: 0,
        config_keys: 0,
      },
    };
  }

  // Validate all behaviors upfront before any mutation
  for (const behavior of behaviors) {
    validateBehavior(behavior);
  }

  // Deep clone the manifest so the original is never mutated
  const m = JSON.parse(JSON.stringify(manifest));

  // Record original counts for delta calculation
  const origExtensions = (m.extensions || []).length;
  const origHooks = (m.hooks || []).length;
  const origGates = (m.gates || []).length;
  const origSubscribes = (m.events?.subscribes || []).length;
  const origJobs = (m.jobs || []).length;
  const origConfigKeys = Object.keys(m.config || {}).length;

  // Initialise manifest arrays/objects that behaviors may append to
  m.extensions = m.extensions || [];
  m.hooks = m.hooks || [];
  m.gates = m.gates || [];
  if (!m.events) m.events = {};
  m.events.subscribes = m.events.subscribes || [];
  m.jobs = m.jobs || [];

  // Accumulators for config and permissions (later behavior wins)
  let accumulatedConfig = {};
  let hasConfig = false;
  let accumulatedPermissions = {};
  let hasPermissions = false;

  const allWarnings = [];

  for (const behavior of behaviors) {
    const bName = behavior.name;

    // extensions — union dedup by value
    if (behavior.extensions) {
      const extSet = new Set(m.extensions);
      for (const ext of behavior.extensions) {
        extSet.add(ext);
      }
      m.extensions = [...extSet];
    }

    // hooks — append
    if (behavior.hooks) {
      const hooksList = Array.isArray(behavior.hooks) ? behavior.hooks : [];
      m.hooks = [...m.hooks, ...hooksList];
    }

    // gates — append
    if (behavior.gates) {
      const gatesList = Array.isArray(behavior.gates) ? behavior.gates : [];
      m.gates = [...m.gates, ...gatesList];
    }

    // events.subscribes — expand wildcards against manifest publishes then append with dedup
    if (behavior.events?.subscribes) {
      const publishes = m.events.publishes || [];
      const { expanded, warnings } = expandEventWildcards(behavior.events.subscribes, publishes);
      for (const w of warnings) {
        allWarnings.push(`${bName}: ${w}`);
      }
      const existingSubs = new Set(m.events.subscribes);
      for (const evt of expanded) {
        if (!existingSubs.has(evt)) {
          existingSubs.add(evt);
          m.events.subscribes.push(evt);
        }
      }
    }

    // config — accumulate with later-behavior-wins via deepMergeDefaults
    if (behavior.config !== undefined) {
      accumulatedConfig = deepMergeDefaults(behavior.config, accumulatedConfig);
      hasConfig = true;
    }

    // permissions — same accumulation strategy as config
    if (behavior.permissions !== undefined) {
      accumulatedPermissions = deepMergeDefaults(behavior.permissions, accumulatedPermissions);
      hasPermissions = true;
    }

    // jobs — append
    if (behavior.jobs) {
      const jobsList = Array.isArray(behavior.jobs) ? behavior.jobs : [];
      m.jobs = [...m.jobs, ...jobsList];
    }

    // context.include — append
    if (behavior.context?.include) {
      if (!m.context) m.context = {};
      if (!m.context.include) m.context.include = [];
      m.context.include = [...m.context.include, ...behavior.context.include];
    }

    // agents.include — append
    if (behavior.agents?.include) {
      if (!m.agents) m.agents = {};
      if (!m.agents.include) m.agents.include = [];
      m.agents.include = [...m.agents.include, ...behavior.agents.include];
    }
  }

  // Apply accumulated behavior config as defaults — manifest wins
  if (hasConfig) {
    m.config = deepMergeDefaults(m.config || {}, accumulatedConfig);
  }

  // Apply accumulated behavior permissions as defaults — manifest wins
  if (hasPermissions) {
    m.permissions = deepMergeDefaults(m.permissions, accumulatedPermissions);
  }

  // Calculate deltas
  const deltas = {
    extensions: m.extensions.length - origExtensions,
    hooks: m.hooks.length - origHooks,
    gates: m.gates.length - origGates,
    event_subscriptions: m.events.subscribes.length - origSubscribes,
    jobs: m.jobs.length - origJobs,
    config_keys: Object.keys(m.config || {}).length - origConfigKeys,
  };

  return { manifest: m, warnings: allWarnings, deltas };
}

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { Resolver } from './resolver.js';
import { computeFileHash } from './resolver/lock.js';
import {
  DependencyViolationError,
  InterfaceNotFoundError,
  ContractViolationError,
  BundleNotFoundError,
} from './errors.js';

// Fix 1: Sensitive field scrubbing — prevent passwords/secrets from leaking into hook contexts
const SENSITIVE_KEYS = new Set(['password', 'password_digest', 'secret', 'token', 'jwt_secret', 'key', 'authorization']);

function scrubSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const scrubbed = {};
  for (const [k, v] of Object.entries(obj)) {
    scrubbed[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return scrubbed;
}

/**
 * ScopedCoordinator — capability-restricted proxy for cross-bundle calls.
 *
 * Each bundle receives a ScopedCoordinator that only allows calling interfaces
 * on bundles listed in its depends_on or optional_deps. This makes dependency
 * declarations enforceable at runtime, not just conventional.
 */
export class ScopedCoordinator {
  constructor(registry, bundleName, allowedBundles) {
    this._registry = registry;
    this._bundleName = bundleName;
    this._allowed = new Set(allowedBundles);
  }

  async call(targetBundle, interfaceName, args = {}, options = {}) {
    if (!this._allowed.has(targetBundle)) {
      throw new DependencyViolationError(this._bundleName, targetBundle, [...this._allowed]);
    }
    return this._registry.call(targetBundle, interfaceName, args, options);
  }

  /**
   * Spawn a sub-coordinator scoped to a single target bundle.
   * Useful for delegated work without exposing full coordinator access.
   */
  spawn(targetBundle) {
    if (!this._allowed.has(targetBundle)) {
      throw new DependencyViolationError(this._bundleName, targetBundle, [...this._allowed]);
    }
    return new ScopedCoordinator(this._registry, `${this._bundleName}:spawn`, [targetBundle]);
  }
}

export class Registry {
  /**
   * @param {object} opts
   * @param {object} opts.dataLayer - DataLayer instance (from @torquedev/datalayer)
   * @param {object} opts.eventBus - EventBus instance (from @torquedev/eventbus)
   * @param {function} opts.createScopedData - (dataLayer, bundleName) => BundleScopedData
   * @param {object} [opts.hookBus] - HookBus instance for lifecycle hooks
   * @param {function} [opts.typeValidator] - (declaredType, value, fieldName) => string|null
   */
  constructor({ dataLayer, eventBus, createScopedData, hookBus = null, typeValidator = null, silent = false }) {
    this.dataLayer = dataLayer;
    this.eventBus = eventBus;
    this.createScopedData = createScopedData;
    this.hookBus = hookBus;
    this.silent = silent;
    this._typeValidator = typeValidator;
    this.log = silent ? () => {} : console.log.bind(console);
    this.bundles = {};
    this.interfaces = {};
    this.mountPlan = null;
    this._loadedContexts = {};
    this._agents = [];
    this._appliedBehaviors = [];
    this._validationMode = 'warn'; // 'warn' | 'strict'
    this._eventValidationMode = 'warn'; // 'warn' | 'strict'
    this._lockData = null; // Fix 2: populated from resolver to enable integrity verification
    this._contentHashes = new Set(); // Item 6: content deduplication
    this._lazyBundles = {}; // Item 3: lazy bundle activation
    this._bundleRegistry = null; // Item 4: persistent registry
  }

  async boot(mountPlanPath, { sorted, bundleDirs, lock } = {}) {
    // Fix 2: Store lock data so loadBundle() can verify file hashes
    if (lock) this._lockData = lock;
    this.mountPlan = typeof mountPlanPath === 'object' ? mountPlanPath : Resolver.loadMountPlan(mountPlanPath);
    const planBundles = this.mountPlan.bundles || {};

    // Read validation strictness from mount plan: "warn" (default) or "strict"
    this._validationMode = this.mountPlan.validation?.contracts || 'warn';
    this._eventValidationMode = this.mountPlan.validation?.events || 'warn';
    if (this._validationMode === 'strict') {
      this.log('[kernel] Contract validation: STRICT mode — violations will throw errors');
    }
    if (this._eventValidationMode === 'strict') {
      this.log('[kernel] Event validation: STRICT mode — violations will throw errors');
    }
    // Propagate event validation mode to EventBus
    if (this.eventBus.setValidationMode) {
      this.eventBus.setValidationMode(this._eventValidationMode);
    }

    // Item 4: Initialize persistent bundle registry
    this._bundleRegistry = new BundleRegistryStore();

    // Load behaviors from mount plan (now async for Item 5 hook loading)
    for (const ref of this.mountPlan.behaviors || []) {
      await this._loadBehavior(ref);
    }

    // Load context from mount plan
    for (const ref of this.mountPlan.context?.include || []) {
      this._loadContextFile(ref);
    }

    // Load agent definitions from mount plan
    for (const ref of this.mountPlan.agents?.include || []) {
      this._loadAgentDef(ref);
    }

    const bootOrder = sorted || Object.entries(planBundles)
      .filter(([, c]) => c.enabled)
      .map(([n]) => n);

    for (const name of bootOrder) {
      const config = planBundles[name];
      if (!config?.enabled) continue;
      const dir = bundleDirs?.[name] || `bundles/${name}`;
      // Item 3: Lazy activation — defer boot until first access
      if (config.activation === 'lazy') {
        this._lazyBundles[name] = { config, dir };
        this.log(`  [lazy] ${name} — deferred until first access`);
        continue;
      }
      await this.loadBundle(name, config, dir);
    }

    for (const [name, bundle] of Object.entries(this.bundles)) {
      if (bundle.instance.setupSubscriptions) {
        bundle.instance.setupSubscriptions(this.eventBus);
      }
    }

    // Cross-check events.subscribes: each declared subscription must have a registered subscriber
    const allSubscriptions = this.eventBus.subscriptions();
    for (const [bundleName, bundleData] of Object.entries(this.bundles)) {
      const declaredSubs = bundleData.manifest.events?.subscribes || [];
      for (const eventName of declaredSubs) {
        const subscribers = allSubscriptions[eventName] || [];
        if (!subscribers.includes(bundleName)) {
          this._contractViolation(
            bundleName,
            `declares subscription to '${eventName}' but never subscribed\n  Fix: call eventBus.subscribe('${eventName}', ...) in setupSubscriptions() in logic.js, or remove from events.subscribes in manifest.yml`
          );
        }
      }
    }

    this._logBootSummary();
  }

  async loadBundle(name, config, bundleDir) {
    const manifestPath = `${bundleDir}/manifest.yml`;

    if (!existsSync(manifestPath)) {
      throw new BundleNotFoundError(name, bundleDir);
    }

    const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));

    // Hook: before boot
    if (this.hookBus) {
      this.hookBus.emitSync('bundle:before-boot', { bundleName: name, manifest });
    }

    const bootStart = Date.now();

    if (manifest.schema?.tables) {
      this.dataLayer.registerSchema(name, manifest.schema.tables);
    }

    // Register declared events for runtime validation
    if (manifest.events?.publishes?.length) {
      if (this.eventBus.registerDeclaredEvents) {
        this.eventBus.registerDeclaredEvents(name, manifest.events.publishes.map(e => e.name));
      }
      if (this.eventBus.registerEventSchemas) {
        this.eventBus.registerEventSchemas(name, manifest.events.publishes);
      }
    }

    // Fix 2: Verify logic.js integrity against stored hash before importing
    if (this._lockData?.[name]?.logic_hash) {
      const expectedHash = this._lockData[name].logic_hash;
      const actualHash = computeFileHash(join(bundleDir, 'logic.js'));
      if (actualHash !== expectedHash) {
        throw new BundleNotFoundError(
          name,
          `logic.js integrity check failed: expected ${expectedHash.slice(0, 12)}..., got ${actualHash?.slice(0, 12)}...`
        );
      }
    }

    const absoluteLogicPath = resolve(`${bundleDir}/logic.js`);
    const mod = await import(absoluteLogicPath);
    const BundleClass = mod.default;
    const declaredDeps = [
      ...(manifest.depends_on || []),
      ...(manifest.optional_deps || []),
    ];
    const scopedCoordinator = new ScopedCoordinator(this, name, declaredDeps);
    const instance = new BundleClass({
      data: this.createScopedData(this.dataLayer, name),
      events: this.eventBus,
      config,
      coordinator: scopedCoordinator,
    });

    this.bundles[name] = { manifest, instance, config, dir: bundleDir, intents: {} };

    // Load per-bundle agent definition if present
    const agentPath = `${bundleDir}/agent.md`;
    if (existsSync(agentPath)) {
      this._loadAgentDef(agentPath);
      if (this._agents.length) this._agents[this._agents.length - 1].bundle = name;
    }

    // Register IDD Intents if the bundle exports them
    const implementedIntentsObj = instance.intents ? instance.intents() : {};
    for (const [intentKey, intentInstance] of Object.entries(implementedIntentsObj)) {
      this.bundles[name].intents[intentKey] = intentInstance;
    }
    if (Object.keys(implementedIntentsObj).length > 0) {
      this.log(`[kernel] Registered ${Object.keys(implementedIntentsObj).length} IDD intents for ${name}`);
    }

    // Cross-check intents: bidirectional manifest.intents vs instance.intents() keys
    const declaredIntentNames = new Set(manifest.intents || []);
    const implementedIntentNames = new Set(Object.keys(implementedIntentsObj));
    for (const intentKey of declaredIntentNames) {
      if (!implementedIntentNames.has(intentKey)) {
        this._contractViolation(
          `${name}.intents.${intentKey}`,
          `declared in manifest but not returned by intents()\n  Fix: add '${intentKey}' to intents() in logic.js, or remove from manifest`
        );
      }
    }
    for (const intentKey of implementedIntentNames) {
      if (!declaredIntentNames.has(intentKey)) {
        this._contractViolation(
          `${name}.intents.${intentKey}`,
          `returned by intents() but not declared in manifest\n  Fix: add '${intentKey}' to intents: list in manifest.yml, or remove from intents()`
        );
      }
    }

    if (instance.interfaces) {
      const implemented = instance.interfaces();
      for (const [ifaceName, handler] of Object.entries(implemented)) {
        this.interfaces[`${name}.${ifaceName}`] = handler;
      }

      // Cross-reference manifest declarations vs implementation.
      // Declared interfaces = union of interfaces.queries + interfaces.contracts keys
      const declared = new Set([
        ...(manifest.interfaces?.queries || []),
        ...Object.keys(manifest.interfaces?.contracts || {}),
      ]);
      const implementedNames = new Set(Object.keys(implemented));
      for (const ifaceName of declared) {
        if (!implementedNames.has(ifaceName)) {
          this._contractViolation(
            `${name}.${ifaceName}`,
            `declared in manifest but not implemented\n  Fix: add '${ifaceName}' to interfaces() in logic.js, or remove from manifest`
          );
        }
      }
      for (const ifaceName of implementedNames) {
        if (!declared.has(ifaceName)) {
          this._contractViolation(
            `${name}.${ifaceName}`,
            `implemented but not declared in manifest\n  Fix: add '${ifaceName}' to interfaces.queries or interfaces.contracts in manifest.yml`
          );
        }
      }
    }

    // Cross-check api.routes[].handler: each declared route handler must exist in instance.routes()
    if (manifest.api?.routes?.length) {
      const routeHandlers = instance.routes?.() || {};
      for (const route of manifest.api.routes) {
        if (route.handler && !(route.handler in routeHandlers)) {
          this._contractViolation(
            `${name}`,
            `route '${route.method} ${route.path}' declares handler '${route.handler}' but it is missing from routes() in logic.js\n  Fix: add a '${route.handler}' handler to routes() in logic.js, or remove/rename the handler in manifest.yml`
          );
        }
      }
    }

    const bootMs = Date.now() - bootStart;
    this.log(`[kernel] Booted bundle: ${name} (v${manifest.version}) from ${bundleDir} [${bootMs}ms]`);

    // Hook: after boot
    if (this.hookBus) {
      this.hookBus.emitSync('bundle:after-boot', { bundleName: name, manifest, durationMs: bootMs });
    }

    // Item 4: Record in persistent registry
    if (this._bundleRegistry) {
      this._bundleRegistry.recordBundle(name, {
        source: this.mountPlan?.bundles?.[name]?.source || bundleDir,
        version: manifest.version,
        tables: Object.keys(manifest.schema?.tables || {}),
        routeCount: (manifest.api?.routes || []).length,
        eventCount: (manifest.events?.publishes || []).length,
        bootDurationMs: bootMs,
      });
    }
  }

  async call(bundleName, interfaceName, args = {}, options = {}) {
    // Item 3: Lazy activation — boot bundle on first interface call
    if (!this.bundles[bundleName] && this._lazyBundles[bundleName]) {
      const lazy = this._lazyBundles[bundleName];
      this.log(`[lazy] Activating ${bundleName} (triggered by ${interfaceName})`);
      await this.loadBundle(bundleName, lazy.config, lazy.dir);
      if (this.bundles[bundleName]?.instance?.setupSubscriptions) {
        this.bundles[bundleName].instance.setupSubscriptions(this.eventBus);
      }
      delete this._lazyBundles[bundleName];
    }
    const key = `${bundleName}.${interfaceName}`;
    const handler = this.interfaces[key];
    if (!handler) throw new InterfaceNotFoundError(bundleName, interfaceName);

    // Fix 1: Scrub sensitive args before they touch any hook or gate context
    const safeArgs = scrubSensitive(args);

    // Gate: authorization / rate-limiting — can abort the call by throwing
    if (this.hookBus) {
      this.hookBus.runGate('interface:gate', { bundle: bundleName, method: interfaceName, args: safeArgs, options });
    }

    // Hook: before call — awaited so async auth hooks (e.g. AuthorizationService) actually block
    if (this.hookBus) {
      await this.hookBus.emit('interface:before-call', { bundle: bundleName, method: interfaceName, args: safeArgs, options });
    }

    // ── Input validation ────────────────────────────────────────────────────────
    const manifest = this.bundles[bundleName]?.manifest;

    if (this._typeValidator) {
      const inputContract = manifest?.interfaces?.contracts?.[interfaceName]?.input;
      if (inputContract) {
        const tag = `${bundleName}.${interfaceName}`;
        for (const [fieldName, fieldDef] of Object.entries(inputContract)) {
          const value = args[fieldName];
          const absent = value === undefined || value === null;
          if (fieldDef.required && absent) {
            this._contractViolation(
              tag,
              `input missing required field '${fieldName}'\n  Fix: include '${fieldName}' in args, or remove 'required: true' from interfaces.contracts.${interfaceName}.input.${fieldName} in manifest.yml`
            );
          } else if (!absent && fieldDef.type) {
            const violation = this._typeValidator(fieldDef.type, value, fieldName);
            if (violation) {
              this._contractViolation(tag, violation);
            }
          }
        }
      }
    }

    const start = Date.now();
    try {
      const result = await handler(args);

      // Nullable enforcement: flag null returns when output.nullable is false
      if (this._typeValidator) {
        const outputContract = this.bundles[bundleName]?.manifest?.interfaces?.contracts?.[interfaceName]?.output;
        if (outputContract?.nullable === false && (result === null || result === undefined)) {
          this._contractViolation(
            `${bundleName}.${interfaceName}`,
            `returned null but output.nullable is false\n  Fix: return a valid object from ${interfaceName}, or set output.nullable to true in manifest.yml`
          );
        }
      }

      // Contract validation: check return value against manifest interface schema
      if (manifest?.interfaces?.contracts?.[interfaceName]?.output?.shape && result && !result.error) {
        const shape = manifest.interfaces.contracts[interfaceName].output.shape;
        const declaredFields = Object.keys(shape);
        const actualFields = Object.keys(result);
        for (const field of declaredFields) {
          if (!actualFields.includes(field) && result[field] === undefined) {
            this._contractViolation(
              `${bundleName}.${interfaceName}`,
              `output missing declared field '${field}'\n  Fix: include '${field}' in return value, or remove from interfaces.contracts.${interfaceName}.output.shape in manifest.yml`
            );
          } else if (this._typeValidator && result[field] !== undefined) {
            // Note: input validation is guarded at block level (`if (this._typeValidator)`);
            // output type validation is guarded per-iteration because this loop is shared
            // with the pre-existing field-presence check above.
            const violation = this._typeValidator(shape[field], result[field], field);
            if (violation) {
              this._contractViolation(`${bundleName}.${interfaceName}`, violation);
            }
          }
        }
        // Extra field detection: flag fields in result not declared in shape
        if (this._typeValidator) {
          for (const field of actualFields) {
            if (!declaredFields.includes(field)) {
              this._contractViolation(
                `${bundleName}.${interfaceName}`,
                `output has undeclared field '${field}'\n  Fix: add '${field}' to interfaces.contracts.${interfaceName}.output.shape in manifest.yml, or remove from return value`
              );
            }
          }
        }
      }

      // Array output validation: check output.type === 'array' with items shape
      // requires typeValidator — including the array-type check itself
      if (this._typeValidator) {
        const outputContract = manifest?.interfaces?.contracts?.[interfaceName]?.output;
        // `!result.error` guards against error-sentinel objects handlers may return instead of arrays
        if (outputContract?.type === 'array' && result != null && !result.error) {
          if (!Array.isArray(result)) {
            this._contractViolation(
              key,
              `expected array output, got ${typeof result}\n  Fix: return an array from ${interfaceName}, or change output.type in manifest.yml`
            );
          } else if (outputContract.items) {
            for (const [i, item] of result.entries()) {
              // items schema only applies to non-null object-shaped items; primitives and null are skipped
              if (item && typeof item === 'object') {
                for (const [field, type] of Object.entries(outputContract.items)) {
                  if (item[field] !== undefined) {
                    const violation = this._typeValidator(type, item[field], `[${i}].${field}`);
                    if (violation) {
                      this._contractViolation(key, violation);
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Hook: after call
      if (this.hookBus) {
        this.hookBus.emitSync('interface:after-call', {
          bundle: bundleName, method: interfaceName, args: safeArgs, result, durationMs: Date.now() - start,
        });
      }

      return result;
    } catch (e) {
      // Hook: call error
      if (this.hookBus) {
        this.hookBus.emitSync('interface:error', {
          bundle: bundleName, method: interfaceName, args: safeArgs, error: e.message, durationMs: Date.now() - start,
        });
      }
      throw e;
    }
  }

  activeBundles() { return Object.keys(this.bundles); }
  lazyBundles() { return Object.keys(this._lazyBundles); }
  bundleInstance(name) { return this.bundles[name]?.instance; }
  bundleManifest(name) { return this.bundles[name]?.manifest; }
  bundleDir(name) { return this.bundles[name]?.dir || this._lazyBundles[name]?.dir; }

  /**
   * Wire realtime channel declarations from all loaded bundle manifests into the WebSocketHub.
   * Iterates over loaded bundles and calls wsHub.registerChannels() for each manifest's
   * realtime.channels array.
   * @param {object} wsHub - WebSocketHub instance
   */
  wireRealtimeChannels(wsHub) {
    for (const [bundleName, bundleData] of Object.entries(this.bundles)) {
      const channels = bundleData.manifest.realtime?.channels;
      if (channels?.length) {
        wsHub.registerChannels(bundleName, channels);
      }
    }
  }

  /**
   * Item 8: Create a spawned coordinator scoped to a single target bundle.
   */
  createSpawnedCoordinator(parentBundle, targetBundle) {
    const parent = this.bundles[parentBundle];
    if (!parent) throw new BundleNotFoundError(parentBundle, 'spawn source');
    const declaredDeps = [...(parent.manifest.depends_on || []), ...(parent.manifest.optional_deps || [])];
    if (!declaredDeps.includes(targetBundle)) {
      throw new DependencyViolationError(parentBundle, targetBundle, declaredDeps);
    }
    return {
      call: (interfaceName, args) => this.call(targetBundle, interfaceName, args),
      instance: () => this.bundleInstance(targetBundle),
    };
  }

  /**
   * Report a contract violation. In "warn" mode, logs a warning.
   * In "strict" mode, throws a ContractViolationError.
   */
  _contractViolation(tag, message) {
    if (this._validationMode === 'strict') {
      throw new ContractViolationError(tag, message);
    }
    console.warn(`[contract] ${tag}: ${message}`);
  }

  async _loadBehavior(ref) {
    const filePath = this.resolveBundleRef(typeof ref === 'string' ? ref : ref.path);
    if (!existsSync(filePath)) { console.warn(`[kernel] Behavior not found: ${filePath}`); return; }
    const behavior = yaml.load(readFileSync(filePath, 'utf8'));
    const name = behavior.name || filePath;
    this._appliedBehaviors.push(name);

    // Merge context includes from behavior
    for (const ctx of behavior.context?.include || []) {
      this._loadContextFile(ctx);
    }

    // Wire event subscriptions from behavior
    if (behavior.events?.subscribes && this.eventBus) {
      for (const sub of behavior.events.subscribes) {
        const eventName = typeof sub === 'string' ? sub : sub.event;
        this.eventBus.subscribe(eventName, `behavior:${name}`, (payload) => {
          this.log(`[behavior:${name}] ${eventName}: ${JSON.stringify(payload).slice(0, 200)}`);
        });
      }
    }

    // Item 5: Register hook handlers from behavior
    if (behavior.hooks && this.hookBus) {
      for (const hook of behavior.hooks) {
        const handlerPath = this.resolveBundleRef(hook.handler);
        if (typeof handlerPath === 'string' && existsSync(handlerPath)) {
          const mod = await import(resolve(handlerPath));
          this.hookBus.on(hook.position, mod.default || mod, { name: `behavior:${name}` });
        }
      }
    }

    // Item 5: Register gate handlers from behavior
    if (behavior.gates && this.hookBus) {
      for (const gate of behavior.gates) {
        const handlerPath = this.resolveBundleRef(gate.handler);
        if (typeof handlerPath === 'string' && existsSync(handlerPath)) {
          const mod = await import(resolve(handlerPath));
          this.hookBus.gate(gate.position, mod.default || mod, { name: `behavior:${name}` });
        }
      }
    }

    this.log(`[kernel] Loaded behavior: ${name}`);
  }

  /**
   * Item 2: Resolve @bundleName:path references to absolute file paths.
   */
  resolveBundleRef(ref) {
    if (typeof ref !== 'string') return ref;
    const match = ref.match(/^@([^:]+):(.+)$/);
    if (!match) return ref;
    const [, bundleName, relPath] = match;
    const dir = this.bundleDir(bundleName);
    if (!dir) return ref; // Bundle not yet loaded, return as-is
    return join(dir, relPath);
  }

  _loadContextFile(ref) {
    const filePath = this.resolveBundleRef(typeof ref === 'string' ? ref : ref.path);
    if (!existsSync(filePath)) { return; }
    const content = readFileSync(filePath, 'utf8');
    // Item 6: Content deduplication — skip if same content already loaded via another path
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    if (this._contentHashes.has(hash)) return;
    this._contentHashes.add(hash);
    this._loadedContexts[ref] = content;
  }

  _loadAgentDef(ref) {
    const filePath = this.resolveBundleRef(typeof ref === 'string' ? ref : ref.path);
    if (!existsSync(filePath)) { return; }
    const raw = readFileSync(filePath, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) {
      const meta = yaml.load(fmMatch[1]);
      this._agents.push({ meta: meta.meta || meta, body: fmMatch[2].trim(), _source: filePath });
    } else {
      this._agents.push({ meta: { name: filePath }, body: raw, _source: filePath });
    }
  }

  _logBootSummary() {
    this.log(`[kernel] Boot complete: ${Object.keys(this.bundles).length} bundles active`);
    for (const [name, b] of Object.entries(this.bundles)) {
      const tables = this.dataLayer.tablesFor(name);
      const events = b.manifest.events?.publishes?.length || 0;
      const routes = b.manifest.api?.routes?.length || 0;
      this.log(`  ${name}: ${tables.length} tables, ${events} published events, ${routes} API routes`);
    }
    const subs = this.eventBus.subscriptions();
    const total = Object.values(subs).flat().length;
    this.log(`  Event subscriptions: ${total} total`);
    for (const [event, bundles] of Object.entries(subs)) {
      this.log(`    ${event} -> ${bundles.join(', ')}`);
    }
    if (this.hookBus) {
      const hookSummary = this.hookBus.summary();
      const hookCount = Object.values(hookSummary).flat().length;
      if (hookCount > 0) {
        this.log(`  Lifecycle hooks: ${hookCount} total`);
        for (const [position, names] of Object.entries(hookSummary)) {
          this.log(`    ${position} -> ${names.join(', ')}`);
        }
      }
    }

    // Item 4: Save persistent registry after boot
    if (this._bundleRegistry) {
      this._bundleRegistry.save();
    }
  }
}

/**
 * Item 4: BundleRegistryStore — persists bundle metadata to .torque/registry.json
 */
class BundleRegistryStore {
  constructor(path = '.torque/registry.json') {
    this._path = path;
    this._data = this._load();
  }

  _load() {
    try { return JSON.parse(readFileSync(this._path, 'utf8')); }
    catch { return { bundles: {}, lastBoot: null }; }
  }

  save() {
    this._data.lastBoot = new Date().toISOString();
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2));
    } catch { /* silent — persistence is best-effort */ }
  }

  recordBundle(name, { source, version, tables, routeCount, eventCount, bootDurationMs }) {
    this._data.bundles[name] = {
      source, version, tables, routeCount, eventCount, bootDurationMs,
      lastBooted: new Date().toISOString(),
    };
  }

  getBundle(name) { return this._data.bundles[name]; }
  listBundles() { return this._data.bundles; }
}

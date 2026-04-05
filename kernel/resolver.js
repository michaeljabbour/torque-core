import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, resolve, join, basename } from 'path';
import yaml from 'js-yaml';
import { resolveGit, updateGit } from './resolver/git.js';
import { resolvePath } from './resolver/path.js';
import { readLock, writeLock, getLockEntry, setLockEntry, computeFileHash } from './resolver/lock.js';
import { ensureCacheDir, cachePath, isCacheFresh, isCached } from './resolver/cache.js';
import { resolveDependencyOrder } from './resolver/deps.js';

export class Resolver {
  /**
   * Interpolate ${VAR} placeholders with process.env values.
   * Throws if a referenced variable is missing (unless prefixed with ?).
   */
  static interpolateEnv(yamlString) {
    return yamlString.replace(/\$\{(\??)([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, optional, varName) => {
      const value = process.env[varName];
      if (value !== undefined) return value;
      if (optional === '?') {
        // Provide sensible dev defaults for common vars
        const defaults = { AUTH_SECRET: 'torque-dev-secret', JWT_SECRET: 'torque-dev-secret' };
        return defaults[varName] || '';
      }
      throw new Error(`Environment variable '${varName}' is required but not set. Use \${?${varName}} to make it optional.`);
    });
  }

  /**
   * Load and parse a mount plan YAML with env var interpolation.
   */
  static loadMountPlan(path) {
    const raw = readFileSync(path, 'utf8');
    const interpolated = Resolver.interpolateEnv(raw);
    return yaml.load(interpolated);
  }

  /**
   * Auto-discover bundles from a local bundles/ directory.
   * No mount plan YAML needed — convention over configuration.
   * Returns a synthetic mount plan object, or null if no bundles/ dir exists.
   */
  static autoDiscover(appDir = '.') {
    // Check both bundles/ (convention) and .bundles/ (git-cached)
    let bundlesDir = join(appDir, 'bundles');
    let prefix = 'bundles';
    if (!existsSync(bundlesDir)) {
      bundlesDir = join(appDir, '.bundles');
      prefix = '.bundles';
    }
    if (!existsSync(bundlesDir)) return null;

    const entries = readdirSync(bundlesDir, { withFileTypes: true });
    const bundles = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(bundlesDir, entry.name);
      const manifestPath = join(dir, 'manifest.yml');
      if (!existsSync(manifestPath)) continue;

      // Read manifest to extract config hints
      const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
      const config = {};
      // Auto-detect auth bundles and inject JWT secret from env
      if (manifest.name === 'iam' || entry.name === 'iam' || manifest.name === 'identity' || entry.name === 'identity') {
        config.jwt_secret = process.env.AUTH_SECRET || process.env.JWT_SECRET || 'torque-dev-secret';
        config.token_expiry = '7d';
      }

      bundles[entry.name] = { source: `path:./${prefix}/${entry.name}`, enabled: true, config };
    }

    if (Object.keys(bundles).length === 0) return null;

    return {
      app: { name: basename(resolve(appDir)) },
      bundles,
    };
  }

  /**
   * Resolve all bundle sources from a mount plan.
   * Remote bundles are fetched to .bundles/. Local bundles are symlinked.
   * Returns the dependency-sorted order of bundle names.
   */
  async resolve(mountPlanPath, { force = false, silent = false } = {}) {
    const log = silent ? () => {} : console.log.bind(console);
    // Accept either a file path (string) or a pre-built plan object (from autoDiscover)
    const plan = typeof mountPlanPath === 'object' ? mountPlanPath : Resolver.loadMountPlan(mountPlanPath);
    const planDir = typeof mountPlanPath === 'string' ? dirname(resolve(mountPlanPath)) : resolve('.');
    const bundles = plan.bundles || {};
    const lock = readLock();
    let lockChanged = false;

    ensureCacheDir();

    const enabledBundles = [];
    const bundleDirs = {};

    // Phase 1: Process local and path bundles (fast, serial); collect git bundles
    const gitBundles = [];

    for (const [name, config] of Object.entries(bundles)) {
      if (!config.enabled) continue;
      enabledBundles.push(name);

      const source = config.source;
      if (!source) {
        // Local bundle — check bundles/<name>/ first, then .bundles/<name>/
        const localDir = `bundles/${name}`;
        const cacheDir = cachePath(name);
        bundleDirs[name] = existsSync(localDir) ? localDir : cacheDir;
        continue;
      }

      if (source.startsWith('path:')) {
        const relativePath = source.replace(/^path:/, '');
        // Resolve relative to the app root (cwd), not the mount plan directory
        const absolutePath = resolve(relativePath);
        if (existsSync(absolutePath)) {
          // Local path exists — use it directly (no copy needed)
          bundleDirs[name] = absolutePath;
        } else {
          // Try resolving relative to mount plan dir as fallback
          const target = cachePath(name);
          resolvePath(source, target, planDir);
          bundleDirs[name] = target;
        }
        continue;
      }

      // Expand github: shorthand → git+https://github.com/...
      if (source.startsWith('github:')) {
        const repo = source.replace(/^github:/, '');
        const expanded = `git+https://github.com/${repo}${repo.endsWith('.git') ? '' : '.git'}@main`;
        gitBundles.push([name, { ...config, source: expanded }]);
        continue;
      }

      if (source.startsWith('git+')) {
        gitBundles.push([name, config]);
        continue;
      }

      throw new Error(`Unknown bundle source type: ${source}`);
    }

    // Phase 2: Resolve all git bundles in parallel (network I/O — benefits from concurrency)
    await Promise.all(
      gitBundles.map(async ([name, config]) => {
        const source = config.source;
        const target = cachePath(name);
        const lockEntry = getLockEntry(lock, name);

        // Fix 3: Warn when a non-SHA ref is used in production (branch names can drift)
        if (process.env.NODE_ENV === 'production') {
          const ref = source.split('@').pop();
          if (!/^[0-9a-f]{40}$/.test(ref)) {
            console.warn(
              `[resolver] WARNING: Bundle '${name}' uses ref '${ref}' instead of a commit SHA. ` +
              `In production, pin to a full commit SHA for reproducible builds.`
            );
          }
        }

        if (!force && isCacheFresh(name, lockEntry)) {
          log(`[resolver] ${name}: cached at ${lockEntry.commit.slice(0, 8)}`);
          bundleDirs[name] = target;
          return;
        }

        const result = force
          ? await updateGit(source, target)
          : await resolveGit(source, target);

        // Fix 2: Compute and store SHA-256 hashes of bundle files for integrity verification
        const manifestHash = computeFileHash(join(target, 'manifest.yml'));
        const logicHash = computeFileHash(join(target, 'logic.js'));

        setLockEntry(lock, name, { source, ...result, manifest_hash: manifestHash, logic_hash: logicHash });
        lockChanged = true;
        log(`[resolver] ${name}: resolved to ${result.commit.slice(0, 8)} (${result.ref})`);
        bundleDirs[name] = target;
      })
    );

    if (lockChanged) {
      writeLock(lock);
      log('[resolver] Updated bundle.lock');
    }

    // Item 1: Resolve includes: — bundles that include other bundles get implicit depends_on
    this._resolveIncludes(bundleDirs, enabledBundles, log);

    // Phase 3: Read manifests and topological sort (must be serial — needs all dirs populated)
    const sorted = resolveDependencyOrder(bundleDirs, enabledBundles);
    log(`[resolver] Boot order: ${sorted.join(' -> ')}`);

    return { sorted, bundleDirs, lock };
  }

  /**
   * Item 1: Resolve includes: declarations in bundle manifests.
   * Logs which bundles include others. The actual dependency injection
   * happens in deps.js resolveDependencyOrder() which reads includes: as implicit depends_on.
   */
  _resolveIncludes(bundleDirs, enabledBundles, log) {
    for (const [name, dir] of Object.entries(bundleDirs)) {
      const manifestPath = join(dir, 'manifest.yml');
      if (!existsSync(manifestPath)) continue;
      const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
      const includes = manifest.includes || [];
      if (includes.length === 0) continue;
      const incNames = includes.map(i => typeof i === 'string' ? i : i.bundle || i.name).filter(Boolean);
      log(`[resolver] ${name} includes: [${incNames.join(', ')}]`);
      for (const inc of incNames) {
        if (!enabledBundles.includes(inc)) {
          log(`[resolver] WARNING: ${name} includes '${inc}' but it is not enabled`);
        }
      }
    }
  }

  /**
   * List all resolved bundles and their sources.
   */
  list(mountPlanPath) {
    const plan = Resolver.loadMountPlan(mountPlanPath);
    const lock = readLock();
    const results = [];

    for (const [name, config] of Object.entries(plan.bundles || {})) {
      if (!config.enabled) continue;
      const lockEntry = getLockEntry(lock, name);
      results.push({
        name,
        source: config.source || 'local',
        commit: lockEntry?.commit?.slice(0, 8) || null,
        ref: lockEntry?.ref || null,
        resolved_at: lockEntry?.resolved_at || null,
      });
    }
    return results;
  }

  /**
   * Validate dependencies without fetching.
   */
  check(mountPlanPath) {
    const plan = Resolver.loadMountPlan(mountPlanPath);
    const bundles = plan.bundles || {};
    const enabledBundles = Object.entries(bundles)
      .filter(([, c]) => c.enabled)
      .map(([n]) => n);

    const bundleDirs = {};
    for (const name of enabledBundles) {
      const localDir = `bundles/${name}`;
      const cacheDir = cachePath(name);
      bundleDirs[name] = existsSync(localDir) ? localDir : cacheDir;
    }

    return resolveDependencyOrder(bundleDirs, enabledBundles);
  }
}

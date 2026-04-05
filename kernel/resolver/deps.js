import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { CircularDependencyError } from '../errors.js';

/**
 * Topological sort of bundles based on depends_on declarations.
 * Returns an ordered array of bundle names (dependencies first).
 * Throws on missing dependencies or circular references.
 */
export function resolveDependencyOrder(bundleDirs, enabledBundles) {
  const manifests = {};
  for (const [name, dir] of Object.entries(bundleDirs)) {
    const manifestPath = `${dir}/manifest.yml`;
    if (existsSync(manifestPath)) {
      manifests[name] = yaml.load(readFileSync(manifestPath, 'utf8'));
    }
  }

  // Item 1: Merge includes: into depends_on (includes are implicit hard dependencies)
  for (const [name, manifest] of Object.entries(manifests)) {
    const includes = (manifest.includes || []).map(i => typeof i === 'string' ? i : i.bundle || i.name).filter(Boolean);
    if (includes.length > 0) {
      manifest.depends_on = [...new Set([...(manifest.depends_on || []), ...includes])];
    }
  }

  // Check hard dependencies
  for (const [name, manifest] of Object.entries(manifests)) {
    const deps = manifest.depends_on || [];
    for (const dep of deps) {
      if (!enabledBundles.includes(dep)) {
        throw new Error(
          `Bundle '${name}' requires '${dep}' but '${dep}' is not enabled in the mount plan.`
        );
      }
    }
  }

  // Topological sort (Kahn's algorithm)
  const graph = {};
  const inDegree = {};
  for (const name of enabledBundles) {
    graph[name] = [];
    inDegree[name] = 0;
  }

  for (const [name, manifest] of Object.entries(manifests)) {
    const deps = manifest.depends_on || [];
    for (const dep of deps) {
      if (graph[dep]) {
        graph[dep].push(name);
        inDegree[name] = (inDegree[name] || 0) + 1;
      }
    }
  }

  const queue = enabledBundles.filter(n => inDegree[n] === 0);
  const sorted = [];

  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const dependent of (graph[current] || [])) {
      inDegree[dependent]--;
      if (inDegree[dependent] === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== enabledBundles.length) {
    const missing = enabledBundles.filter(n => !sorted.includes(n));
    const cyclePath = _traceCycle(manifests, missing);
    throw new CircularDependencyError(cyclePath);
  }

  return sorted;
}

/**
 * DFS-based cycle path tracer.
 * Given manifests and a set of bundle names known to be in a cycle,
 * returns a human-readable cycle path string like 'A -> B -> C -> A'.
 * @param {object} manifests - map of bundle name to parsed manifest
 * @param {string[]} startNodes - bundle names known to be in the cycle
 * @returns {string} cycle path like 'A -> B -> A'
 */
function _traceCycle(manifests, startNodes) {
  // Build depends_on graph: name -> [dependencies]
  const graph = {};
  for (const [name, manifest] of Object.entries(manifests)) {
    graph[name] = (manifest.depends_on || []).filter(d => d in manifests);
  }

  // DFS cycle detection
  const visited = new Set();
  const onStack = new Set();
  const path = [];

  function dfs(node) {
    if (onStack.has(node)) {
      // Found a back edge - extract the cycle portion
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart);
      cycle.push(node); // close the cycle: A -> B -> A
      return cycle.join(' -> ');
    }
    if (visited.has(node)) return null;

    visited.add(node);
    onStack.add(node);
    path.push(node);

    for (const dep of (graph[node] || [])) {
      const result = dfs(dep);
      if (result) return result;
    }

    path.pop();
    onStack.delete(node);
    return null;
  }

  for (const start of startNodes) {
    if (!visited.has(start)) {
      const result = dfs(start);
      if (result) return result;
    }
  }

  // Fallback: return missing bundles joined with ->
  return startNodes.join(' -> ');
}

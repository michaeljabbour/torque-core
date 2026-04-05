/**
 * Torque kernel error classes.
 * All errors extend the native Error class and include:
 * - name — the class name
 * - message — human-readable description with fix instructions
 * - code — machine-readable error code
 */

export class CircularDependencyError extends Error {
  constructor(cyclePath) {
    const pathStr = Array.isArray(cyclePath) ? cyclePath.join(' -> ') : String(cyclePath);
    super(
      `Circular dependency detected: ${pathStr}. ` +
      `Remove the cycle from your bundle depends_on declarations.`
    );
    this.name = 'CircularDependencyError';
    this.code = 'CIRCULAR_DEPENDENCY';
    this.cyclePath = cyclePath;
  }
}

export class ContractViolationError extends Error {
  constructor(tag, message) {
    super(`[contract] ${tag}: ${message}`);
    this.name = 'ContractViolationError';
    this.code = 'CONTRACT_VIOLATION';
    this.tag = tag;
    this.violationMessage = message;
  }
}

export class BundleNotFoundError extends Error {
  constructor(bundleName, bundleDir) {
    super(
      `Bundle '${bundleName}' not found: no manifest.yml at '${bundleDir}/manifest.yml'. ` +
      `Fix: ensure the bundle directory exists and contains a manifest.yml file.`
    );
    this.name = 'BundleNotFoundError';
    this.code = 'BUNDLE_NOT_FOUND';
    this.bundleName = bundleName;
    this.bundleDir = bundleDir;
  }
}

export class InterfaceNotFoundError extends Error {
  constructor(bundleName, interfaceName) {
    super(
      `No interface '${interfaceName}' on bundle '${bundleName}'. ` +
      `Fix: ensure '${interfaceName}' is declared in manifest.yml and implemented in logic.js.`
    );
    this.name = 'InterfaceNotFoundError';
    this.code = 'INTERFACE_NOT_FOUND';
    this.bundleName = bundleName;
    this.interfaceName = interfaceName;
  }
}

export class DependencyViolationError extends Error {
  constructor(callerBundle, targetBundle, declaredDeps) {
    const depsStr = Array.isArray(declaredDeps) ? declaredDeps.join(', ') : String(declaredDeps);
    super(
      `Bundle '${callerBundle}' cannot call '${targetBundle}': ` +
      `'${targetBundle}' is not in depends_on or optional_deps. ` +
      `Declared dependencies: [${depsStr}]. ` +
      `Fix: add '${targetBundle}' to depends_on in ${callerBundle}/manifest.yml.`
    );
    this.name = 'DependencyViolationError';
    this.code = 'DEPENDENCY_VIOLATION';
    this.callerBundle = callerBundle;
    this.targetBundle = targetBundle;
    this.declaredDeps = declaredDeps;
  }
}

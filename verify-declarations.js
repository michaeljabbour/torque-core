/**
 * Verification script: checks that the actual JS exports match the TypeScript declarations.
 * Usage: node verify-declarations.js
 * Expected output: "All exports match declarations"
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = false;

function check(label, condition, detail = '') {
  if (!condition) {
    console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed = true;
  } else {
    console.log(`  PASS: ${label}`);
  }
}

// ── 1. Check .d.ts files exist ──────────────────────────────────────────────
console.log('\n[torque-core] Checking declaration files exist...');
check('torque-core/index.d.ts exists', existsSync(join(__dirname, 'index.d.ts')));
check('torque-core/boot.d.ts exists',  existsSync(join(__dirname, 'boot.d.ts')));

// ── 2. Check package.json has "types" and conditional exports ────────────────
const pkg = JSON.parse(
  (await import('fs')).readFileSync(join(__dirname, 'package.json'), 'utf8')
);

console.log('\n[torque-core] Checking package.json fields...');
check('package.json has "types"', pkg.types === 'index.d.ts', `got: ${pkg.types}`);
check(
  'exports["."] has conditional types',
  typeof pkg.exports?.['.'] === 'object' &&
    pkg.exports?.['.']?.types === './index.d.ts',
  JSON.stringify(pkg.exports?.['.'])
);
check(
  'exports["./boot"] has conditional types',
  typeof pkg.exports?.['./boot'] === 'object' &&
    pkg.exports?.['./boot']?.types === './boot.d.ts',
  JSON.stringify(pkg.exports?.['./boot'])
);
check(
  'exports["."].default exists',
  pkg.exports?.['.']?.default != null,
  JSON.stringify(pkg.exports?.['.'])
);
check(
  'exports["./boot"].default exists',
  pkg.exports?.['./boot']?.default != null,
  JSON.stringify(pkg.exports?.['./boot'])
);

// ── 3. Import the actual JS module and check all declared exports ─────────────
console.log('\n[torque-core] Checking JS module exports...');

const coreExports = await import('./index.js');
const declaredCoreExports = [
  // Error classes
  'CircularDependencyError',
  'ContractViolationError',
  'BundleNotFoundError',
  'InterfaceNotFoundError',
  'DependencyViolationError',
  // Classes
  'ScopedCoordinator',
  'Registry',
  'HookBus',
  'WebSocketHub',
  'JobRunner',
  // IDD Primitives
  'Intent',
  'Behavior',
  'Context',
  'AgentRouter',
];

for (const name of declaredCoreExports) {
  check(`index.js exports '${name}'`, name in coreExports, `got: ${typeof coreExports[name]}`);
}

console.log('\n[torque-core] Checking boot.js exports...');
const bootExports = await import('./boot.js');
check("boot.js exports 'boot'", typeof bootExports.boot === 'function');

// ── 4. Verify ScopedCoordinator shape ───────────────────────────────────────
console.log('\n[torque-core] Checking ScopedCoordinator shape...');
const { ScopedCoordinator } = coreExports;
check('ScopedCoordinator is a class/function', typeof ScopedCoordinator === 'function');
const proto = ScopedCoordinator.prototype;
check('ScopedCoordinator has call()', typeof proto.call === 'function');
check('ScopedCoordinator has spawn()', typeof proto.spawn === 'function');

// ── 5. Verify Registry shape ─────────────────────────────────────────────────
console.log('\n[torque-core] Checking Registry shape...');
const { Registry } = coreExports;
check('Registry is a class/function', typeof Registry === 'function');
const regProto = Registry.prototype;
check('Registry has boot()',           typeof regProto.boot === 'function');
check('Registry has loadBundle()',     typeof regProto.loadBundle === 'function');
check('Registry has call()',           typeof regProto.call === 'function');
check('Registry has activeBundles()', typeof regProto.activeBundles === 'function');
check('Registry has bundleManifest()', typeof regProto.bundleManifest === 'function');
check('Registry has bundleInstance()', typeof regProto.bundleInstance === 'function');
check('Registry has bundleDir()',      typeof regProto.bundleDir === 'function');

// ── 6. Verify HookBus shape ───────────────────────────────────────────────────
console.log('\n[torque-core] Checking HookBus shape...');
const { HookBus } = coreExports;
check('HookBus is a class/function', typeof HookBus === 'function');
const hookProto = HookBus.prototype;
check('HookBus has on()',       typeof hookProto.on === 'function');
check('HookBus has gate()',     typeof hookProto.gate === 'function');
check('HookBus has runGate()',  typeof hookProto.runGate === 'function');
check('HookBus has emit()',     typeof hookProto.emit === 'function');
check('HookBus has emitSync()', typeof hookProto.emitSync === 'function');
check('HookBus has summary()',  typeof hookProto.summary === 'function');

// ── 7. Verify WebSocketHub shape ─────────────────────────────────────────────
console.log('\n[torque-core] Checking WebSocketHub shape...');
const { WebSocketHub } = coreExports;
check('WebSocketHub is a class/function', typeof WebSocketHub === 'function');
check('WebSocketHub has handleUpgrade()', typeof WebSocketHub.prototype.handleUpgrade === 'function');

// ── 8. Verify JobRunner shape ─────────────────────────────────────────────────
console.log('\n[torque-core] Checking JobRunner shape...');
const { JobRunner } = coreExports;
check('JobRunner is a class/function', typeof JobRunner === 'function');
check('JobRunner has registerBundle()',    typeof JobRunner.prototype.registerBundle === 'function');
check('JobRunner has createScopedJobs()', typeof JobRunner.prototype.createScopedJobs === 'function');
check('JobRunner has start()',            typeof JobRunner.prototype.start === 'function');

// ── 9. Verify IDD Primitives ──────────────────────────────────────────────────
console.log('\n[torque-core] Checking IDD Primitives shape...');
const { Intent, Behavior, Context, AgentRouter } = coreExports;
check('Intent is a class/function',      typeof Intent === 'function');
check('Behavior is a class/function',    typeof Behavior === 'function');
check('Context is a class/function',     typeof Context === 'function');
check('AgentRouter is a class/function', typeof AgentRouter === 'function');

// ── Done ──────────────────────────────────────────────────────────────────────
console.log('');
if (failed) {
  console.error('FAIL: Some checks failed (see above)');
  process.exit(1);
} else {
  console.log('All exports match declarations');
}

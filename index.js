export { Registry, ScopedCoordinator } from './kernel/registry.js';
export { Resolver } from './kernel/resolver.js';
export { HookBus } from './kernel/hooks.js';
export { WebSocketHub } from './kernel/ws-hub.js';
export { JobRunner } from './kernel/job-runner.js';
export {
  CircularDependencyError,
  ContractViolationError,
  BundleNotFoundError,
  InterfaceNotFoundError,
  DependencyViolationError,
} from './kernel/errors.js';

// IDD Primitives
export { Intent } from './idd/Intent.js';
export { Behavior } from './idd/Behavior.js';
export { Context } from './idd/Context.js';
export { AgentRouter } from './idd/AgentRouter.js';
export { AgentCoordinator } from './idd/AgentCoordinator.js';
export { ClaudeRuntime } from './idd/claude-runtime.js';

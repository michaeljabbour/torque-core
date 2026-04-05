import { Registry, Resolver, HookBus } from './index.js';

// Simple color helpers (no dependency needed — uses ANSI codes)
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
};

/**
 * High-level boot function that starts a Torque application from a mount plan.
 */
export async function boot(opts) {
  const {
    plan,
    db,
    port = 9292,
    frontendDir,
    shell,
    authResolver,
    serve = true,
    silent = false,
  } = opts;

  const log = silent ? () => {} : console.log.bind(console);
  const err = silent ? () => {} : console.error.bind(console);

  log();
  log(`  ${c.bold(c.cyan('Torque'))}  ${c.dim('Composable Monolith Framework')}`);
  log();

  // Lazy-import services so @torquedev/core doesn't hard-depend on them.
  const { DataLayer, BundleScopedData } = await import('@torquedev/datalayer');
  const { EventBus } = await import('@torquedev/eventbus');

  // 1. Resolve bundle sources (auto-discover if no plan provided)
  let effectivePlan = plan;
  if (!effectivePlan) {
    const discovered = Resolver.autoDiscover();
    if (discovered) {
      log(`  ${c.dim('[auto-discovery]')} Found ${Object.keys(discovered.bundles).length} bundles in bundles/`);
      effectivePlan = discovered;
    }
  }
  // Try default mount plan paths if still no plan
  if (!effectivePlan) {
    const defaults = ['config/mount_plans/development.yml', 'config/mount_plans/default.yml', 'mount_plan.yml'];
    for (const dp of defaults) {
      if ((await import('fs')).existsSync(dp)) { effectivePlan = dp; break; }
    }
  }
  if (!effectivePlan) {
    throw new Error('No bundles/ directory and no mount plan found. Create a bundles/ dir or provide a mount plan.');
  }
  const resolver = new Resolver();
  const resolved = await resolver.resolve(effectivePlan, { silent: true });
  log();

  // 2. Create shared infrastructure
  const dataLayer = new DataLayer(db);
  const hookBus = new HookBus();

  // Wire @torquedev/schema type validation (optional -- gracefully degrades if not installed)
  let typeValidator = null;
  try {
    const { createTypeValidator } = await import('@torquedev/schema');
    typeValidator = createTypeValidator();
  } catch {
    // @torquedev/schema not installed -- type validation disabled
  }

  const eventBus = new EventBus({ db: dataLayer.db, hookBus, typeValidator, silent: true });

  const registry = new Registry({
    dataLayer,
    eventBus,
    hookBus,
    typeValidator,
    createScopedData: (dl, name) => new BundleScopedData(dl, name),
    silent: true, // boot.js prints its own concise summary
  });

  // 3. Boot bundles in dependency order
  await registry.boot(effectivePlan, resolved);

  // 3b. Feature 13: Register background jobs from manifests
  let jobRunner = null;
  try {
    const { JobRunner } = await import('./kernel/job-runner.js');
    jobRunner = new JobRunner(dataLayer, eventBus, { silent: true });
    let totalJobs = 0;
    for (const name of registry.activeBundles()) {
      const m = registry.bundleManifest(name);
      if (m.jobs?.length) {
        const instance = registry.bundleInstance(name);
        jobRunner.registerBundle(name, m, instance);
        // Inject this.jobs into the bundle instance
        instance.jobs = jobRunner.createScopedJobs(name);
        totalJobs += m.jobs.length;
      }
    }
    if (totalJobs > 0) {
      jobRunner.start();
      log(`  ${c.dim('[jobs]')} ${totalJobs} background job(s) registered`);
    }
  } catch {}

  // Print concise boot summary
  const bundles = registry.activeBundles();
  const totalRoutes = bundles.reduce((sum, name) => {
    const m = registry.bundleManifest(name);
    return sum + (m.api?.routes?.length || 0);
  }, 0);
  const totalEvents = eventBus.subscriptions ? Object.keys(eventBus.subscriptions()).length : 0;

  for (const name of bundles) {
    const m = registry.bundleManifest(name);
    const tables = Object.keys(dataLayer.schemas?.[name] || {}).length;
    const routes = m.api?.routes?.length || 0;
    const events = m.events?.publishes?.length || 0;
    const ui = m.ui ? c.cyan('UI') : '';
    log(`  ${c.green('✓')} ${c.bold(name.padEnd(16))} ${c.dim(`${tables}T ${routes}R ${events}E`)} ${ui}`);
  }

  log();
  log(`  ${c.dim(`${bundles.length} bundles  ${totalRoutes} routes  ${totalEvents} subscriptions`)}`);

  // 3c. Optional embedding service (from mount plan embeddings config)
  let embeddingService = null;
  const embeddingsConfig = registry.mountPlan?.embeddings;
  if (embeddingsConfig) {
    try {
      const { EmbeddingService } = await import('@torquedev/ext-embeddings');
      embeddingService = EmbeddingService.create(embeddingsConfig, dataLayer.db);
      log(`  ${c.dim('[embeddings]')} Embedding service enabled`);
    } catch (e) {
      log(`  ${c.dim('[embeddings]')} Disabled (${e.message})`);
    }
  }

  const result = { registry, dataLayer, eventBus, hookBus };
  result.embeddingService = embeddingService;

  // 4. Optionally start HTTP server
  if (serve) {
    const { createServer } = await import('@torquedev/server');

    // Auto-detect auth: if IAM bundle is loaded and no authResolver provided, create one
    let effectiveAuthResolver = authResolver;
    if (!effectiveAuthResolver && registry.bundleInstance('iam')) {
      effectiveAuthResolver = (req) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) return null;
        try { return registry.bundleInstance('iam').validateToken(header.slice(7)); }
        catch { return null; }
      };
      log(`  ${c.dim('[auto-auth]')} Using IAM bundle for JWT authentication`);
    }

    // B6: Agent runtime (IDD) — conditional on Claude SDK availability
    let agentRouter = null;
    try {
      const { ClaudeRuntime } = await import('./idd/claude-runtime.js');
      const runtime = await ClaudeRuntime.create();
      if (runtime._sdk) {
        const { AgentRouter } = await import('./idd/AgentRouter.js');
        agentRouter = new AgentRouter({ registry, runtime, hookBus, embeddingService });
        log(`  ${c.dim('[agent]')} Agent runtime enabled`);
      }
    } catch (e) {
      // Agent runtime not available — continue without it
    }
    result.agentRouter = agentRouter;

    const app = await createServer(registry, eventBus, {
      frontendDir,
      hookBus,
      authResolver: effectiveAuthResolver,
      silent: true,
      agentRouter,
      embeddingService,
    });

    // Mount shell middleware (e.g. React SPA) after API routes
    if (shell) {
      app.use(shell);
    }

    // Bind to the requested port — fail if busy instead of silently rebinding
    let actualPort = port;
    let httpServer;
    await new Promise((resolve, reject) => {
      const tryPort = (p) => {
        const server = app.listen(p, '0.0.0.0', () => {
          log(`  ${c.green('→')} ${c.bold(`http://localhost:${p}`)}`);
          actualPort = p;
          httpServer = server;
          resolve();
        });
        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            log(`\n  ${c.red('✗')} Port ${p} is already in use by another process.`);
            log(`    Run: ${c.dim(`lsof -i :${p}`)} to find it, or ${c.dim(`kill $(lsof -ti :${p})`)} to free it.\n`);
            reject(new Error(`Port ${p} in use`));
          } else {
            reject(err);
          }
        });
      };
      tryPort(port);
    });

    // B5: WebSocket hub for real-time push
    try {
      const { WebSocketHub } = await import('./kernel/ws-hub.js');
      const wsHub = new WebSocketHub(eventBus, { authResolver: effectiveAuthResolver });
      await wsHub.handleUpgrade(httpServer);
      registry.wireRealtimeChannels(wsHub);
      wsHub.setCoordinator(registry);
      result.wsHub = wsHub;
      log(`  ${c.dim('[websocket]')} Real-time push enabled at /__torque_ws`);
    } catch (e) {
      log(`  ${c.dim('[websocket]')} Disabled (${e.message})`);
    }

    log();

    result.app = app;
    result.port = actualPort;
  }

  return result;
}

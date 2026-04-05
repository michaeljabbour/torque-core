/**
 * Feature 13: Bundle-scoped background job runner.
 *
 * Jobs are declared in manifest.yml:
 *   jobs:
 *     - name: reindex
 *       handler: reindexAll
 *       schedule: "0,30 * * * *"   # optional cron (every 30 min)
 *       retry: { max: 3, backoff: exponential }
 *       timeout: 300s
 *
 * Bundle logic.js receives this.jobs with:
 *   this.jobs.enqueue('reindex', payload)
 *   this.jobs.enqueueIn(5000, 'reindex', payload)
 *
 * Jobs run in-process (composable monolith — no Redis needed).
 * Persisted to SQLite for crash recovery via a _torque_jobs table.
 */

export class JobRunner {
  constructor(dataLayer, eventBus, { silent = false } = {}) {
    this.dataLayer = dataLayer;
    this.eventBus = eventBus;
    this.silent = silent;
    this._handlers = new Map(); // 'bundle:jobName' -> handlerFn
    this._timers = [];
    this._running = false;
    this._pollInterval = null;

    // Create the jobs table using raw db access
    this.db = dataLayer.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _torque_jobs (
        id TEXT PRIMARY KEY,
        bundle TEXT NOT NULL,
        name TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        backoff TEXT DEFAULT 'exponential',
        run_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Register job handlers from a bundle's manifest + logic instance.
   */
  registerBundle(bundleName, manifest, instance) {
    const jobs = manifest.jobs || [];
    if (!jobs.length) return;

    const routeHandlers = typeof instance.routes === 'function' ? instance.routes() : {};

    for (const job of jobs) {
      const handlerFn = routeHandlers[job.handler] || instance[job.handler];
      if (!handlerFn) {
        if (!this.silent) console.warn(`[jobs] ${bundleName}: handler '${job.handler}' not found for job '${job.name}'`);
        continue;
      }

      const key = `${bundleName}:${job.name}`;
      this._handlers.set(key, {
        fn: handlerFn.bind(instance),
        bundle: bundleName,
        config: job,
      });

      // Schedule cron jobs
      if (job.schedule) {
        this._scheduleCron(key, job.schedule);
      }
    }

    if (!this.silent && jobs.length) {
      console.log(`[jobs] ${bundleName}: ${jobs.length} job(s) registered`);
    }
  }

  /**
   * Create a scoped jobs interface for a bundle.
   */
  createScopedJobs(bundleName) {
    const runner = this;
    return {
      enqueue(jobName, payload = {}) {
        return runner._enqueue(bundleName, jobName, payload, new Date().toISOString());
      },
      enqueueIn(delayMs, jobName, payload = {}) {
        const runAt = new Date(Date.now() + delayMs).toISOString();
        return runner._enqueue(bundleName, jobName, payload, runAt);
      },
      enqueueAt(date, jobName, payload = {}) {
        return runner._enqueue(bundleName, jobName, payload, date.toISOString());
      },
    };
  }

  _enqueue(bundle, name, payload, runAt) {
    const id = crypto.randomUUID?.() || require('crypto').randomUUID();
    const key = `${bundle}:${name}`;
    const handler = this._handlers.get(key);
    const maxAttempts = handler?.config?.retry?.max || 3;
    const backoff = handler?.config?.retry?.backoff || 'exponential';

    this.db.prepare(`
      INSERT INTO _torque_jobs (id, bundle, name, payload, status, max_attempts, backoff, run_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, bundle, name, JSON.stringify(payload), maxAttempts, backoff, runAt, new Date().toISOString());

    // Trigger immediate processing if due now
    if (new Date(runAt) <= new Date()) {
      this._processNext();
    }

    return id;
  }

  /**
   * Start the job runner polling loop.
   */
  start(intervalMs = 5000) {
    if (this._running) return;
    this._running = true;
    this._pollInterval = setInterval(() => this._processNext(), intervalMs);
    // Process immediately on start
    this._processNext();
  }

  stop() {
    this._running = false;
    if (this._pollInterval) clearInterval(this._pollInterval);
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  async _processNext() {
    const now = new Date().toISOString();
    const job = this.db.prepare(`
      SELECT * FROM _torque_jobs
      WHERE status = 'pending' AND run_at <= ?
      ORDER BY run_at ASC LIMIT 1
    `).get(now);

    if (!job) return;

    const key = `${job.bundle}:${job.name}`;
    const handler = this._handlers.get(key);
    if (!handler) {
      this.db.prepare(`UPDATE _torque_jobs SET status = 'failed', error = 'Handler not found' WHERE id = ?`).run(job.id);
      return;
    }

    // Mark as running
    this.db.prepare(`UPDATE _torque_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`)
      .run(new Date().toISOString(), job.id);

    try {
      const payload = JSON.parse(job.payload || '{}');
      await handler.fn(payload);

      // Success
      this.db.prepare(`UPDATE _torque_jobs SET status = 'completed', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), job.id);

      // Publish completion event
      if (handler.config.events_on_complete) {
        for (const evt of handler.config.events_on_complete) {
          this.eventBus.publish(evt, { job_id: job.id, bundle: job.bundle, name: job.name });
        }
      }
    } catch (err) {
      const attempts = (job.attempts || 0) + 1;
      if (attempts >= job.max_attempts) {
        this.db.prepare(`UPDATE _torque_jobs SET status = 'failed', error = ? WHERE id = ?`)
          .run(err.message, job.id);
      } else {
        // Retry with backoff
        const delay = job.backoff === 'exponential'
          ? Math.pow(2, attempts) * 1000
          : attempts * 5000; // linear
        const retryAt = new Date(Date.now() + delay).toISOString();
        this.db.prepare(`UPDATE _torque_jobs SET status = 'pending', run_at = ?, error = ? WHERE id = ?`)
          .run(retryAt, err.message, job.id);
      }
    }

    // Process next immediately if there are more
    if (this._running) setImmediate(() => this._processNext());
  }

  /**
   * Simple cron parser — supports: "* * * * *" (min hour dom month dow)
   */
  _scheduleCron(key, schedule) {
    const check = () => {
      if (!this._running) return;
      const now = new Date();
      if (this._cronMatches(schedule, now)) {
        const handler = this._handlers.get(key);
        if (handler) {
          this._enqueue(handler.bundle, handler.config.name, {}, now.toISOString());
        }
      }
    };

    // Check every 60 seconds
    const timer = setInterval(check, 60000);
    this._timers.push(timer);
  }

  _cronMatches(schedule, date) {
    const parts = schedule.split(/\s+/);
    if (parts.length < 5) return false;
    const [min, hour, dom, month, dow] = parts;
    const checks = [
      [min, date.getMinutes()],
      [hour, date.getHours()],
      [dom, date.getDate()],
      [month, date.getMonth() + 1],
      [dow, date.getDay()],
    ];
    return checks.every(([pattern, value]) => {
      if (pattern === '*') return true;
      if (pattern.includes('/')) {
        const step = parseInt(pattern.split('/')[1]);
        return value % step === 0;
      }
      return parseInt(pattern) === value;
    });
  }

  /** Get job stats */
  stats() {
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM _torque_jobs GROUP BY status
    `).all();
    return Object.fromEntries(counts.map(r => [r.status, r.count]));
  }
}

/**
 * The background job runtime.
 *
 * Three design choices worth stating, because each rules out something that
 * looks simpler.
 *
 * 1. MUTUAL EXCLUSION IS A POSTGRES ADVISORY LOCK, NOT A REDIS LOCK.
 *    Helm is deployed on-premises, frequently as two app servers behind a load
 *    balancer. Both would run this runtime, and two concurrent sync runs
 *    against one connection is how duplicate assets get created. An advisory
 *    lock costs nothing, is released automatically if the process dies, and —
 *    the real reason — needs no second piece of infrastructure to be correct.
 *    A Redis lock would make Redis a dependency of CORRECTNESS rather than of
 *    throughput, on a deployment where nobody is monitoring Redis. Helm
 *    therefore ships no broker at all; there is nothing to configure.
 *
 * 2. THE SCHEDULER IS A TICK, NOT A CRON DAEMON.
 *    Each job declares how often it should run; the runtime wakes on a short
 *    interval and runs whatever is due. Restarts do not lose a schedule,
 *    because "due" is computed from the database state the job reads, not from
 *    an in-memory timetable.
 *
 * 3. A JOB THAT THROWS DOES NOT STOP THE RUNTIME.
 *    It is logged, counted, and retried on the next tick. The failure that
 *    matters — a job failing every tick for a week — is visible in the
 *    consecutive-failure count rather than in a process that quietly exited at
 *    3am.
 */
import type { HelmSql } from '../lib/db/client';
import { db } from '../lib/db/client';

export interface JobContext {
  /** Structured logging. Never receives secret material. */
  readonly log: JobLogger;
  /** True once shutdown has begun; long loops should check it and stop early. */
  readonly stopping: () => boolean;
}

export interface Job {
  readonly name: string;
  /** How often this job should run, in milliseconds. */
  readonly everyMs: number;
  /**
   * Distinct per job. Two runtimes running the same job take the same lock, so
   * exactly one of them does the work.
   */
  readonly lockKey: number;
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobResult {
  /** Free-form counters for the log line: { tenants: 3, fired: 12 }. */
  readonly counts?: Record<string, number>;
  /** Set when the job did nothing because there was nothing to do. */
  readonly idle?: boolean;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JobLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): JobLogger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Line-per-event JSON logging.
 *
 * On-premises this ends up in journald or a file that someone greps, so the
 * message stays human-readable and the structure rides alongside it. Errors are
 * rendered as message + name; a stack trace from a Postgres driver can contain
 * a query, and a query can contain data.
 */
export function createLogger(name: string, level: LogLevel = 'info'): JobLogger {
  const build = (base: Record<string, unknown>): JobLogger => {
    const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      if (LEVELS[lvl] < LEVELS[level]) return;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level: lvl,
        logger: name,
        msg: message,
        ...base,
        ...fields,
      });
      if (lvl === 'error' || lvl === 'warn') console.error(line);
      else console.log(line);
    };

    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build({});
}

/** What an error may contribute to a log line. Never a stack, never a query. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      error: error.message,
      errorType: error.name,
      ...(typeof code === 'string' ? { errorCode: code } : {}),
    };
  }
  return { error: String(error) };
}

/**
 * Run `fn` while holding a session-level advisory lock, or skip it.
 *
 * Session-level rather than transaction-level, because a job runs many
 * transactions and must hold the lock across all of them. The `finally` is the
 * important part: an unreleased session lock survives until the connection
 * closes, and a pooled connection can live for hours.
 *
 * `pg_try_advisory_lock` never waits. A second runtime that cannot take the
 * lock skips this tick rather than queueing behind the first, which is correct
 * for periodic work — the next tick is only seconds away.
 */
export async function withJobLock<T>(
  sql: HelmSql,
  key: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  // Reserve one connection for the whole lock lifetime. Taking the lock on a
  // pooled connection and releasing it on a different one is a silent no-op
  // that leaves the lock held forever.
  return sql.reserve().then(async (reserved) => {
    try {
      const [row] = await reserved<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${key}::bigint) AS locked
      `;
      if (!row?.locked) return null;

      try {
        return await fn();
      } finally {
        await reserved`SELECT pg_advisory_unlock(${key}::bigint)`;
      }
    } finally {
      reserved.release();
    }
  });
}

export interface RuntimeOptions {
  /** How often to check whether any job is due. */
  readonly tickMs?: number;
  readonly logger?: JobLogger;
  /** Run every job once, then stop. For a cron-driven deployment, and for tests. */
  readonly once?: boolean;
}

interface JobState {
  lastRunAt: number;
  running: boolean;
  consecutiveFailures: number;
}

export class WorkerRuntime {
  readonly #jobs: Job[];
  readonly #state = new Map<string, JobState>();
  readonly #log: JobLogger;
  readonly #tickMs: number;
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #idle: Promise<void> = Promise.resolve();

  constructor(jobs: Job[], options: RuntimeOptions = {}) {
    const duplicateLock = jobs.find((j, i) => jobs.findIndex((o) => o.lockKey === j.lockKey) !== i);
    if (duplicateLock) {
      // Two jobs sharing a lock key would serialise against each other forever,
      // and the symptom — one job that mysteriously never runs — is miserable
      // to diagnose at 3am.
      throw new Error(`two jobs share advisory lock key ${duplicateLock.lockKey}`);
    }

    this.#jobs = jobs;
    this.#log = options.logger ?? createLogger('worker');
    this.#tickMs = options.tickMs ?? 15_000;
    for (const job of jobs) {
      this.#state.set(job.name, { lastRunAt: 0, running: false, consecutiveFailures: 0 });
    }
  }

  /** Run every job once, regardless of schedule. Returns when all have settled. */
  async runOnce(): Promise<void> {
    await Promise.all(this.#jobs.map((job) => this.#runJob(job, true)));
  }

  start(): void {
    if (this.#timer) return;
    this.#log.info('worker runtime started', {
      jobs: this.#jobs.map((j) => j.name),
      tickMs: this.#tickMs,
    });

    const tick = (): void => {
      if (this.#stopping) return;
      this.#idle = Promise.all(this.#jobs.map((job) => this.#runJob(job, false))).then(() => undefined);
    };

    tick();
    this.#timer = setInterval(tick, this.#tickMs);
    // Do not hold the event loop open on account of the scheduler alone.
    this.#timer.unref?.();
  }

  /** Stop scheduling and wait for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#idle;
    this.#log.info('worker runtime stopped');
  }

  async #runJob(job: Job, force: boolean): Promise<void> {
    const state = this.#state.get(job.name);
    if (!state) return;

    // A job still running from a previous tick is not started again. This is
    // the in-process half of the guarantee; the advisory lock is the
    // cross-process half.
    if (state.running) return;
    if (!force && Date.now() - state.lastRunAt < job.everyMs) return;

    state.running = true;
    const log = this.#log.child({ job: job.name });
    const startedAt = Date.now();

    try {
      const result = await withJobLock(db('worker'), job.lockKey, () =>
        job.run({ log, stopping: () => this.#stopping }),
      );

      state.lastRunAt = Date.now();
      state.consecutiveFailures = 0;

      if (result === null) {
        log.debug('skipped: another runtime holds the lock');
      } else if (!result.idle) {
        log.info('completed', { ms: Date.now() - startedAt, ...(result.counts ?? {}) });
      } else {
        log.debug('nothing to do', { ms: Date.now() - startedAt });
      }
    } catch (error) {
      state.lastRunAt = Date.now();
      state.consecutiveFailures += 1;
      log.error('failed', {
        ms: Date.now() - startedAt,
        consecutiveFailures: state.consecutiveFailures,
        ...describeError(error),
      });
    } finally {
      state.running = false;
    }
  }
}

/**
 * Graceful shutdown.
 *
 * In Kubernetes a rolling deploy sends SIGTERM to every pod, several times a
 * day. A worker that dies mid-post leaves an invoice in `posting` with a QBO
 * write possibly in flight — the exact state that costs a manual reconciliation.
 *
 * So shutdown is ordered: stop accepting new work, let in-flight work finish
 * within a deadline, then close connections. The hard-exit timer is a backstop
 * for a hung handler, and it is deliberately shorter than Kubernetes'
 * terminationGracePeriodSeconds so we exit on our terms rather than by SIGKILL.
 */

import type { Logger } from './logger.js';

export interface ShutdownTask {
  readonly name: string;
  /** Lower runs first. Stop intake before draining, drain before closing I/O. */
  readonly order: number;
  run(): Promise<void>;
}

export class ShutdownManager {
  private readonly tasks: ShutdownTask[] = [];
  private shuttingDown = false;
  private readonly controller = new AbortController();

  constructor(
    private readonly logger: Logger,
    private readonly graceMs = 25_000,
  ) {}

  /** Cancels in-flight work that opted in by accepting a signal. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  register(task: ShutdownTask): void {
    this.tasks.push(task);
  }

  install(): void {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => {
        void this.shutdown(sig);
      });
    }

    // An unhandled rejection means we are in an unknown state. Log loudly and
    // exit rather than continuing to process financial transactions blind.
    process.on('unhandledRejection', (reason) => {
      this.logger.fatal({ err: reason }, 'unhandled rejection; shutting down');
      void this.shutdown('unhandledRejection', 1);
    });
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'uncaught exception; shutting down');
      void this.shutdown('uncaughtException', 1);
    });
  }

  async shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info({ reason, graceMs: this.graceMs }, 'shutdown initiated');

    const hardExit = setTimeout(() => {
      this.logger.fatal({ reason }, 'grace period expired; forcing exit');
      process.exit(exitCode || 1);
    }, this.graceMs);
    hardExit.unref();

    try {
      for (const task of [...this.tasks].sort((a, b) => a.order - b.order)) {
        const started = Date.now();
        try {
          await task.run();
          this.logger.info({ task: task.name, ms: Date.now() - started }, 'shutdown task done');
        } catch (err) {
          // One failing task must not prevent the rest from running — closing
          // the DB pool matters even if the HTTP server refused to close.
          this.logger.error({ task: task.name, err }, 'shutdown task failed');
        }
      }
      // Signalled last: tasks may need it to remain unaborted while draining.
      this.controller.abort(new Error(`shutdown: ${reason}`));
    } finally {
      clearTimeout(hardExit);
      this.logger.info({ reason }, 'shutdown complete');
      process.exit(exitCode);
    }
  }
}

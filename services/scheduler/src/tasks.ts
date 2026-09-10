/**
 * Periodic maintenance.
 *
 * Everything here shares a shape: cheap to run, catastrophic to skip, and
 * invisible when it works. That combination is exactly why these get forgotten
 * until the night they matter.
 *
 *   - **Partitions.** `ensure_monthly_partitions` is idempotent and already
 *     written; nothing called it. When the last manual run's runway expires,
 *     every INSERT into `invoices` fails at 00:00 on the 1st. Not degraded —
 *     stopped.
 *   - **Refresh-token expiry.** Intuit expires a refresh token after ~100 days
 *     of inactivity even though the connection auto-refreshes on use. A tenant
 *     who stops sending invoices for a quarter comes back to a dead
 *     integration, and the first they hear of it is a failed post.
 *   - **Stuck invoices.** The reconciler catches these nightly, but nightly is
 *     too slow for a tenant whose pipeline wedged at 09:00.
 */

import type { Database, ConnectionRepository } from '@onelineflow/db';
import { tenantPipelineStalled, type Logger } from '@onelineflow/observability';

/** Tables partitioned by month. Must match the migrations. */
const PARTITIONED_TABLES = [
  'invoices',
  'invoice_line_items',
  'audit_log',
  'qbo_api_calls',
] as const;

export interface MaintenanceOptions {
  /** How far ahead to pre-create partitions. */
  readonly monthsAhead: number;
  readonly monthsBack: number;
  /**
   * Detach partitions older than this. `null` disables detaching entirely,
   * which is the safe default: silently ageing out a customer's financial
   * history is not a decision a scheduler should make on its own.
   */
  readonly retainMonths: number | null;
  /** Warn when a refresh token expires within this many days. */
  readonly tokenWarningDays: number;
  /** Consider a non-terminal invoice stuck after this long. */
  readonly stallHours: number;
}

export const DEFAULT_MAINTENANCE: MaintenanceOptions = {
  // Three months of runway. A scheduler that dies has a full quarter before
  // inserts start failing, which is enough for someone to notice on a Monday.
  monthsAhead: 3,
  monthsBack: 1,
  retainMonths: null,
  // Intuit's window is ~100 days. 21 days is enough warning to reach a finance
  // team, get it scheduled, and have someone actually click the button.
  tokenWarningDays: 21,
  stallHours: 6,
};

export interface TaskResult {
  readonly task: string;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Partitions                                                          */
/* ------------------------------------------------------------------ */

export async function ensurePartitions(
  db: Database,
  logger: Logger,
  opts: MaintenanceOptions,
): Promise<TaskResult> {
  const created: Record<string, number> = {};

  await db.withBypass('scheduled partition maintenance', async (client) => {
    for (const table of PARTITIONED_TABLES) {
      const { rows } = await client.query<{ ensure_monthly_partitions: number }>(
        'SELECT ensure_monthly_partitions($1, $2, $3)',
        [table, opts.monthsBack, opts.monthsAhead],
      );
      created[table] = rows[0]?.ensure_monthly_partitions ?? 0;
    }
  });

  const total = Object.values(created).reduce((a, b) => a + b, 0);
  if (total > 0) {
    logger.info({ created }, 'created monthly partitions');
  }
  return { task: 'ensure_partitions', ok: true, detail: { created, total } };
}

/**
 * Verify runway independently of the creation call above.
 *
 * `ensure_monthly_partitions` returning 0 is ambiguous: it means either
 * "everything already exists" or "the loop did nothing". Asserting the far
 * boundary exists turns that into a real check — and this is the alert that
 * fires before writes start failing, not after.
 */
export async function checkPartitionRunway(
  db: Database,
  logger: Logger,
  opts: MaintenanceOptions,
): Promise<TaskResult> {
  const missing: string[] = [];

  await db.withBypass('partition runway check', async (client) => {
    for (const table of PARTITIONED_TABLES) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT to_regclass(
                  format('public.%I_p%s', $1::text,
                         to_char(date_trunc('month', now()) + make_interval(months => $2::int),
                                 'YYYYMM'))
                ) IS NOT NULL AS exists`,
        [table, opts.monthsAhead],
      );
      if (!rows[0]?.exists) missing.push(`${table} (+${opts.monthsAhead}mo)`);
    }
  });

  if (missing.length > 0) {
    logger.error({ missing }, 'PARTITION RUNWAY SHORT — inserts will fail when it runs out');
  }
  return {
    task: 'partition_runway',
    ok: missing.length === 0,
    detail: { missing, monthsAhead: opts.monthsAhead },
  };
}

/**
 * Detach aged-out partitions. Never DROP.
 *
 * Detaching is instantaneous and leaves the data intact for export. Dropping
 * financial history on a timer is not something an unattended job should do,
 * so removal stays an explicit human action.
 */
export async function detachOldPartitions(
  db: Database,
  logger: Logger,
  opts: MaintenanceOptions,
): Promise<TaskResult> {
  if (opts.retainMonths === null) {
    return { task: 'detach_partitions', ok: true, detail: { skipped: 'retention disabled' } };
  }

  const detached: string[] = [];
  await db.withBypass('scheduled partition detach', async (client) => {
    for (const table of PARTITIONED_TABLES) {
      const { rows } = await client.query<{ detach_partitions_older_than: string }>(
        'SELECT detach_partitions_older_than($1, $2)',
        [table, opts.retainMonths],
      );
      detached.push(...rows.map((r) => r.detach_partitions_older_than));
    }
  });

  if (detached.length > 0) {
    logger.warn(
      { detached },
      'detached aged-out partitions — data retained, drop them manually after export',
    );
  }
  return { task: 'detach_partitions', ok: true, detail: { detached } };
}

/* ------------------------------------------------------------------ */
/* QuickBooks connection health                                        */
/* ------------------------------------------------------------------ */

export interface ExpiringConnection {
  readonly tenantId: string;
  readonly realmId: string;
  readonly daysRemaining: number;
  readonly consecutiveFailures: number;
}

/**
 * Find connections whose refresh token is close to expiry.
 *
 * `findExpiringSoon` has existed since the connection repository was written
 * and nothing called it. This is the difference between a tenant being told
 * "reconnect QuickBooks this week" and discovering it when a bill fails to post.
 */
export async function checkExpiringConnections(
  db: Database,
  connections: ConnectionRepository,
  logger: Logger,
  opts: MaintenanceOptions,
): Promise<TaskResult & { expiring: ExpiringConnection[] }> {
  const expiring = await db.withBypass('refresh-token expiry sweep', async (client) => {
    const rows = await connections.findExpiringSoon(client, opts.tokenWarningDays);
    return rows.map((row) => ({
      tenantId: row.tenantId,
      realmId: row.realmId,
      daysRemaining: Math.floor((row.refreshTokenExpiresAt.getTime() - Date.now()) / 86_400_000),
      consecutiveFailures: row.consecutiveFailures,
    }));
  });

  for (const conn of expiring) {
    // Already expired is a different severity from "expiring soon".
    const level = conn.daysRemaining <= 0 ? 'error' : conn.daysRemaining <= 7 ? 'warn' : 'info';
    logger[level](
      {
        tenantId: conn.tenantId,
        realmId: conn.realmId,
        daysRemaining: conn.daysRemaining,
      },
      conn.daysRemaining <= 0
        ? 'QuickBooks refresh token has EXPIRED — tenant must reconnect'
        : 'QuickBooks refresh token expiring soon',
    );

    tenantPipelineStalled.set(
      { tenant_id: conn.tenantId, reason: 'qbo_token_expiring' },
      conn.daysRemaining <= 7 ? 1 : 0,
    );
  }

  return {
    task: 'connection_expiry',
    ok: expiring.every((c) => c.daysRemaining > 7),
    detail: { count: expiring.length },
    expiring,
  };
}

/* ------------------------------------------------------------------ */
/* Stuck pipelines                                                     */
/* ------------------------------------------------------------------ */

/**
 * Flag tenants with invoices wedged in a non-terminal state.
 *
 * `needs_review` and `pending_approval` are excluded on purpose: those wait on a
 * human, which is a business delay rather than a system fault. Including them
 * would make the alert fire constantly and be ignored within a week.
 */
export async function checkStalledPipelines(
  db: Database,
  logger: Logger,
  opts: MaintenanceOptions,
): Promise<TaskResult> {
  const stalled = await db.withBypass('stalled pipeline sweep', async (client) => {
    const { rows } = await client.query<{ tenant_id: string; status: string; n: string }>(
      `SELECT tenant_id, status, count(*)::text AS n
         FROM invoices
        WHERE status IN ('received','extracting','extracted','approved','posting')
          AND updated_at < now() - make_interval(hours => $1::int)
        GROUP BY tenant_id, status`,
      [opts.stallHours],
    );
    return rows;
  });

  // Clear previous readings before setting current ones, or a tenant that
  // recovered keeps a stale 1 on the gauge forever.
  tenantPipelineStalled.reset();

  for (const row of stalled) {
    tenantPipelineStalled.set({ tenant_id: row.tenant_id, reason: row.status }, 1);
    logger.warn(
      { tenantId: row.tenant_id, status: row.status, count: Number(row.n) },
      'invoices stuck beyond the SLO',
    );
  }

  return {
    task: 'stalled_pipelines',
    ok: stalled.length === 0,
    detail: { tenants: new Set(stalled.map((r) => r.tenant_id)).size, groups: stalled.length },
  };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run every maintenance task.
 *
 * Tasks are independent and a failure in one must not skip the rest — partition
 * creation matters even if the token sweep cannot reach the database.
 */
export async function runMaintenance(
  db: Database,
  connections: ConnectionRepository,
  logger: Logger,
  opts: MaintenanceOptions = DEFAULT_MAINTENANCE,
): Promise<TaskResult[]> {
  const tasks: Array<() => Promise<TaskResult>> = [
    () => ensurePartitions(db, logger, opts),
    () => checkPartitionRunway(db, logger, opts),
    () => detachOldPartitions(db, logger, opts),
    () => checkExpiringConnections(db, connections, logger, opts),
    () => checkStalledPipelines(db, logger, opts),
  ];

  const results: TaskResult[] = [];
  for (const task of tasks) {
    try {
      results.push(await task());
    } catch (err) {
      logger.error({ err }, 'maintenance task failed');
      results.push({
        task: 'unknown',
        ok: false,
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  logger.info(
    { total: results.length, failed: failed.length, tasks: results.map((r) => r.task) },
    'maintenance sweep complete',
  );
  return results;
}

export { PARTITIONED_TABLES };

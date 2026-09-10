import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRepository, Database } from '@onelineflow/db';
import type { Logger } from '@onelineflow/observability';
import {
  checkExpiringConnections,
  DEFAULT_MAINTENANCE,
  ensurePartitions,
  PARTITIONED_TABLES,
  runMaintenance,
} from './tasks.js';

function fakeLogger(): Logger {
  const noop = vi.fn();
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => fakeLogger(),
  } as unknown as Logger;
}

/** Database stub that records the SQL it was asked to run. */
function fakeDb(rowsFor: (sql: string) => unknown[] = () => []): {
  db: Database;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    query: (sql: string) => {
      queries.push(sql);
      return Promise.resolve({ rows: rowsFor(sql) });
    },
  };
  const db = {
    withBypass: (_reason: string, fn: (c: unknown) => Promise<unknown>) => fn(client),
    withTenant: (_t: unknown, fn: (c: unknown) => Promise<unknown>) => fn(client),
  } as unknown as Database;
  return { db, queries };
}

describe('partition maintenance', () => {
  it('covers every partitioned table', async () => {
    const { db, queries } = fakeDb(() => [{ ensure_monthly_partitions: 0 }]);
    await ensurePartitions(db, fakeLogger(), DEFAULT_MAINTENANCE);
    expect(queries).toHaveLength(PARTITIONED_TABLES.length);
  });

  it('keeps at least three months of runway', () => {
    // A scheduler that dies gets a full quarter before inserts start failing.
    // That is the difference between someone noticing on a Monday and the
    // platform stopping at 00:00 on the 1st.
    expect(DEFAULT_MAINTENANCE.monthsAhead).toBeGreaterThanOrEqual(3);
  });

  it('disables partition detaching by default', () => {
    // Ageing out a customer's financial history is not a decision an
    // unattended job should take on its own.
    expect(DEFAULT_MAINTENANCE.retainMonths).toBeNull();
  });

  it('includes every table the migrations partition', () => {
    expect([...PARTITIONED_TABLES].sort()).toEqual([
      'audit_log',
      'invoice_line_items',
      'invoices',
      'qbo_api_calls',
    ]);
  });
});

describe('refresh-token expiry', () => {
  function connectionsReturning(daysAway: number[]): ConnectionRepository {
    return {
      findExpiringSoon: () =>
        Promise.resolve(
          daysAway.map((d, i) => ({
            id: `conn-${i}`,
            tenantId: `tenant-${i}`,
            realmId: `${1000 + i}`,
            environment: 'production' as const,
            status: 'active' as const,
            accessTokenExpiresAt: new Date(),
            refreshTokenExpiresAt: new Date(Date.now() + d * 86_400_000),
            consecutiveFailures: 0,
          })),
        ),
    } as unknown as ConnectionRepository;
  }

  it('reports nothing when every token is healthy', async () => {
    const { db } = fakeDb();
    const result = await checkExpiringConnections(
      db,
      connectionsReturning([]),
      fakeLogger(),
      DEFAULT_MAINTENANCE,
    );
    expect(result.ok).toBe(true);
    expect(result.expiring).toHaveLength(0);
  });

  it('flags a connection inside the warning window', async () => {
    const { db } = fakeDb();
    const result = await checkExpiringConnections(
      db,
      connectionsReturning([5]),
      fakeLogger(),
      DEFAULT_MAINTENANCE,
    );
    expect(result.ok).toBe(false);
    expect(result.expiring[0]?.daysRemaining).toBe(5);
  });

  it('treats an already-expired token as negative days, not zero', async () => {
    // The distinction matters: "expired 12 days ago" is a different
    // conversation from "expires today".
    const { db } = fakeDb();
    const result = await checkExpiringConnections(
      db,
      connectionsReturning([-12]),
      fakeLogger(),
      DEFAULT_MAINTENANCE,
    );
    expect(result.expiring[0]?.daysRemaining).toBeLessThan(0);
  });

  it('warns well before Intuit’s ~100 day window closes', () => {
    // Long enough to reach a finance team and have someone actually act.
    expect(DEFAULT_MAINTENANCE.tokenWarningDays).toBeGreaterThanOrEqual(14);
    expect(DEFAULT_MAINTENANCE.tokenWarningDays).toBeLessThan(100);
  });
});

describe('runMaintenance', () => {
  it('runs every task', async () => {
    const { db } = fakeDb(() => [{ ensure_monthly_partitions: 0, exists: true }]);
    const connections = {
      findExpiringSoon: () => Promise.resolve([]),
    } as unknown as ConnectionRepository;
    const results = await runMaintenance(db, connections, fakeLogger(), DEFAULT_MAINTENANCE);
    expect(results.map((r) => r.task)).toEqual([
      'ensure_partitions',
      'partition_runway',
      'detach_partitions',
      'connection_expiry',
      'stalled_pipelines',
    ]);
  });

  it('continues after a task throws', async () => {
    // Partition creation matters even if the token sweep cannot reach the
    // database. One failing task must not skip the rest.
    let call = 0;
    const client = {
      query: () => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({ rows: [{ ensure_monthly_partitions: 0, exists: true }] });
      },
    };
    const db = {
      withBypass: (_r: string, fn: (c: unknown) => Promise<unknown>) => fn(client),
    } as unknown as Database;
    const connections = {
      findExpiringSoon: () => Promise.resolve([]),
    } as unknown as ConnectionRepository;

    const results = await runMaintenance(db, connections, fakeLogger(), DEFAULT_MAINTENANCE);
    expect(results).toHaveLength(5);
    expect(results.filter((r) => !r.ok).length).toBeGreaterThan(0);
  });
});

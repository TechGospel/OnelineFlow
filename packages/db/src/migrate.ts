/**
 * Migration runner.
 *
 * Deliberately boring: plain .sql files, applied in filename order, each inside
 * its own transaction, recorded with a checksum. Two properties matter at scale:
 *
 *   1. A session-level advisory lock, so N replicas booting simultaneously
 *      during a rolling deploy do not race. The others block, then no-op.
 *   2. Checksum verification, so an already-applied file that has since been
 *      edited aborts the run instead of leaving environments silently divergent.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

/** Arbitrary but fixed. Any other process using this key would deadlock us. */
const ADVISORY_LOCK_KEY = 0x0f10_0001;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureLedger(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);
}

export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function migrate(
  connectionString: string,
  opts: { dir?: string; dryRun?: boolean } = {},
): Promise<MigrateResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = await loadMigrations(dir);
  const client = new pg.Client({ connectionString, application_name: 'onelineflow-migrate' });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Blocks until any concurrently-booting replica finishes.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureLedger(client);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const previous = seen.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was modified after being applied.\n` +
              `  recorded: ${previous}\n  on disk:  ${file.checksum}\n` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped.push(file.name);
        continue;
      }

      if (opts.dryRun) {
        applied.push(file.name);
        continue;
      }

      const started = Date.now();
      // Each file manages its own BEGIN/COMMIT so that a migration needing
      // CREATE INDEX CONCURRENTLY can opt out of the surrounding transaction.
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file.name, file.checksum, Date.now() - started],
      );
      applied.push(file.name);
      process.stdout.write(`  applied ${file.name} (${Date.now() - started}ms)\n`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }

  return { applied, skipped };
}

/* ---------------------------------------------------------------- CLI --- */
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isDirectRun) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }
  const statusOnly = process.argv.includes('--status');

  migrate(url, { dryRun: statusOnly })
    .then((res) => {
      if (statusOnly) {
        process.stdout.write(
          `pending: ${res.applied.length ? res.applied.join(', ') : '(none)'}\n` +
            `applied: ${res.skipped.length}\n`,
        );
      } else {
        process.stdout.write(
          `Migrations complete. applied=${res.applied.length} skipped=${res.skipped.length}\n`,
        );
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(`Migration failed: ${String(err)}\n`);
      process.exit(1);
    });
}

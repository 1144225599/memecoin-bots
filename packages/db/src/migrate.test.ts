import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { createTestPool, hasTestDatabase, resetDatabase } from './test-db.js';

const EXPECTED_TABLES = [
  'audit_log',
  'bot_heartbeats',
  'bots',
  'fills',
  'monitoring_deliveries',
  'monitoring_events',
  'monitoring_health',
  'monitoring_incidents',
  'orders',
  'paper_execution_attempts',
  'paper_execution_intents',
  'paper_execution_positions',
  'paper_execution_quote_claims',
  'paper_execution_quotes',
  'paper_execution_requests',
  'paper_execution_results',
  'position_exit_decisions',
  'position_exit_fill_receipts',
  'position_exit_observations',
  'position_exit_policies',
  'position_exit_state',
  'positions',
  'risk_admissions',
  'risk_days',
  'risk_decisions',
  'risk_paper_accounts',
  'risk_pnl_events',
  'risk_position_commitments',
  'risk_profiles',
  'risk_reservations',
  'risk_streaks',
  'runtime_config_snapshots',
  'schema_migrations',
  'token_safety_cache',
  'token_safety_evaluations',
  'token_safety_leases',
  'token_safety_snapshots',
  'tokens',
  'wallet_preparations',
  'wallet_reservations',
  'wallet_spend_state',
  'wallets',
];

describe.skipIf(!hasTestDatabase)('migrations', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;

  async function tables(): Promise<string[]> {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    return rows.map((r) => r.tablename);
  }

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('every migration has an up and a down file', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.version)).toContain('0001');
    for (const m of migrations) {
      expect(m.up.trim()).not.toBe('');
      expect(m.down.trim()).not.toBe('');
    }
  });

  it('runs up, is idempotent, runs down, and runs up again', async () => {
    const all = (await loadMigrations()).map((m) => m.version);

    expect(await migrateUp(pool)).toEqual(all);
    expect(await tables()).toEqual(EXPECTED_TABLES);
    expect(await migrateUp(pool)).toEqual([]);

    expect(await migrateDown(pool, all.length)).toEqual([...all].reverse());
    expect(await tables()).toEqual(['schema_migrations']);
    expect((await migrationStatus(pool)).every((m) => m.appliedAt === null)).toBe(true);

    expect(await migrateUp(pool)).toEqual(all);
    expect(await tables()).toEqual(EXPECTED_TABLES);
  });

  it('two processes migrating at once apply each migration exactly once', async () => {
    const [a, b] = await Promise.all([migrateUp(pool), migrateUp(pool)]);
    const all = (await loadMigrations()).map((m) => m.version);
    expect([...a, ...b].sort()).toEqual(all);
  });

  it('rejects a nonsense step count', async () => {
    await expect(migrateDown(pool, 0)).rejects.toThrow(/positive whole number/);
  });
});

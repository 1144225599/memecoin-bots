import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createLogger, loadConfig, SecretRegistry } from '@memebots/config';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWatchdog } from '../../../apps/engine/src/monitoring/watchdog.js';

import { setAuditActor } from './audit.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import {
  acquireBotLeases,
  auditStartup,
  deliverAlerts,
  monitoringHealth,
  observeHealth,
  pollBotAlerts,
  publishBotProgress,
  releaseBotLeases,
  scanBotHealth,
} from './monitoring.js';
import { createPool, withTransaction } from './pool.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';

const MINT = 'So11111111111111111111111111111111111111112';
describe.skipIf(!hasTestDatabase)('durable monitoring and automatic audit', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  async function bot(mode = 'paper') {
    await pool.query(`INSERT INTO risk_profiles(id, display_name, position_fraction, stop_loss_fraction, min_reward_risk,
      max_open_positions, daily_loss_limit_fraction, max_slippage_bps, min_liquidity_usd, min_safety_score, max_hold_minutes, losing_streak_limit, take_profit_ladder, trailing_stop_fraction)
      VALUES('test_profile', 'Test', .02, .2, 2, 5, .05, 100, 100, 50, 60, 3, '[{"atGain":0.3,"sellFraction":0.5}]', .15) ON CONFLICT DO NOTHING`);
    // Public-only test fixture, compatible with BOT8's mandatory bot-wallet association.
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const publicKey = Array.from(randomBytes(32), (byte) => alphabet[byte % alphabet.length]).join(
      '',
    );
    const wallet = await pool.query<{ id: string }>(
      "INSERT INTO wallets(label, public_key, spend_cap_lamports) VALUES('test-public-wallet', $1, 0) RETURNING id",
      [publicKey],
    );
    const result = await pool.query<{ id: string }>(
      `INSERT INTO bots(name, strategy, risk_profile_id, mode, wallet_id) VALUES($1, 'momentum', 'test_profile', $2, $3) RETURNING id`,
      [randomUUID(), mode, wallet.rows[0]!.id],
    );
    return result.rows[0]!.id;
  }
  const age = async (id: string, seconds = 41) =>
    pool.query(
      "UPDATE bot_heartbeats SET expected_since = clock_timestamp() - $2 * interval '1 second', heartbeat_at = NULL WHERE bot_id = $1",
      [id, seconds],
    );
  const events = async () =>
    (await pool.query('SELECT transition FROM monitoring_events ORDER BY id')).rows.map(
      (x) => x.transition,
    );

  it('detects never-started bots, persists dedup across observer restart, recovers and re-stalls', async () => {
    const id = await bot();
    const disabled = await bot('off');
    await age(id);
    await age(disabled);
    const emitted: string[] = [];
    await pollBotAlerts(pool, (event) => emitted.push(event.category));
    expect(emitted).toEqual(['bot_stalled']);
    expect(await events()).toEqual(['opened']);
    // A separate pool contains no in-memory engine/watchdog state.
    const restarted = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      await scanBotHealth(restarted);
      expect(await events()).toEqual(['opened']);
      const [lease] = await acquireBotLeases(pool, randomUUID());
      await publishBotProgress(pool, lease!, 'scaffold');
      await scanBotHealth(restarted);
      expect(await events()).toEqual(['opened', 'resolved']);
      // Simulate whole-engine crash by simply ceasing progress; observer remains independent.
      await age(id);
      await scanBotHealth(restarted);
      expect(await events()).toEqual(['opened', 'resolved', 'opened']);
      const health = await monitoringHealth(restarted);
      expect(health.incidents).toHaveLength(1);
      expect(health.bots.find((x) => x.bot_id === disabled)?.status).toBe('disabled');
    } finally {
      await restarted.end();
    }
  });

  it('independent five-second watchdog emits one crash incident within a minute using a fake clock and real DB', async () => {
    const id = await bot();
    const [lease] = await acquireBotLeases(pool, randomUUID());
    await publishBotProgress(pool, lease!, 'scaffold');
    const lines: string[] = [];
    // Fake timer scheduling only; persisted observation timestamps still come from PostgreSQL.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const watchdog = createWatchdog({
      db: pool,
      logger: createLogger(new SecretRegistry(), (line) => lines.push(line)),
    });
    try {
      watchdog.start();
      // Ensure a prior polling call has finished; PostgreSQL uses real I/O, not fake timers.
      await vi.waitFor(() => expect(lines).toHaveLength(0));
      for (let seconds = 5; seconds <= 50; seconds += 5) {
        await age(id, seconds);
        await vi.advanceTimersByTimeAsync(5_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const alerts = lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === 'monitoring_alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].fields).toMatchObject({
        category: 'bot_stalled',
        transition: 'opened',
        entityId: id,
      });
      expect(await events()).toEqual(['opened']);
    } finally {
      await watchdog.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it('uses a 40 second threshold, graceful stop and mode-off suppress stalls, and fences old writers', async () => {
    const id = await bot();
    const owner = randomUUID();
    const [old] = await acquireBotLeases(pool, owner);
    await expect(acquireBotLeases(pool, randomUUID())).rejects.toThrow('BOT_LEASE_ALREADY_OWNED');
    await age(id, 39);
    await scanBotHealth(pool);
    expect(await events()).toEqual([]);
    await age(id, 41);
    await scanBotHealth(pool);
    expect(await events()).toEqual(['opened']);
    const nextOwner = randomUUID();
    const [next] = await acquireBotLeases(pool, nextOwner);
    await expect(publishBotProgress(pool, old!, 'scaffold')).rejects.toThrow('BOT_LEASE_LOST');
    await releaseBotLeases(pool, owner); // stale shutdown cannot release the new lease.
    await publishBotProgress(pool, next!, 'scaffold');
    await releaseBotLeases(pool, nextOwner);
    await age(id);
    await scanBotHealth(pool);
    expect(await events()).toEqual(['opened', 'resolved']);
    await pool.query("UPDATE bots SET mode = 'off' WHERE id = $1", [id]);
    await expect(publishBotProgress(pool, next!, 'scaffold')).rejects.toThrow('BOT_LEASE_LOST');
    await scanBotHealth(pool);
    expect(await events()).toEqual(['opened', 'resolved']);
  });

  it('resolves a deleted stalled bot on the next scan without changing other incidents or immutable events', async () => {
    const deleted = await bot();
    const other = await bot();
    await age(deleted);
    await age(other);
    await observeHealth(pool, 'rpc_unhealthy', 'solana', true, 'http');
    await scanBotHealth(pool);
    const prior = (await pool.query('SELECT * FROM monitoring_events ORDER BY id')).rows;
    expect(prior).toHaveLength(3);
    const incident = (
      await pool.query<{ id: string }>(
        "SELECT id FROM monitoring_incidents WHERE category = 'bot_stalled' AND entity_id = $1",
        [deleted],
      )
    ).rows[0]!;
    await pool.query('DELETE FROM bots WHERE id = $1', [deleted]);
    expect(
      (await pool.query('SELECT * FROM bot_heartbeats WHERE bot_id = $1', [deleted])).rowCount,
    ).toBe(0);
    await scanBotHealth(pool);
    const after = (await pool.query('SELECT * FROM monitoring_events ORDER BY id')).rows;
    expect(after.slice(0, prior.length)).toEqual(prior);
    expect(after).toHaveLength(4);
    expect(after[3]).toMatchObject({
      incident_id: incident.id,
      transition: 'resolved',
      code: 'heartbeat_stale',
    });
    const open = (await monitoringHealth(pool)).incidents;
    expect(open.map((row) => row.entity_id).sort()).toEqual([other, 'solana'].sort());
    expect(
      (
        await pool.query('SELECT resolved_at FROM monitoring_incidents WHERE id = $1', [
          incident.id,
        ])
      ).rows[0].resolved_at,
    ).not.toBeNull();
    await scanBotHealth(pool);
    expect((await pool.query('SELECT * FROM monitoring_events')).rowCount).toBe(4);
  });

  it('outbox retries after a failed sink and restart, with durable recovery and a new incident on relapse', async () => {
    await observeHealth(pool, 'rpc_unhealthy', 'solana', true, 'http');
    await observeHealth(pool, 'rpc_unhealthy', 'solana', true, 'timeout');
    await expect(
      deliverAlerts(pool, () => {
        throw new Error('sink unavailable');
      }),
    ).rejects.toThrow();
    const delivered: string[] = [];
    await deliverAlerts(pool, (e) => delivered.push(e.id));
    await deliverAlerts(pool, (e) => delivered.push(e.id));
    expect(delivered).toHaveLength(1);
    await observeHealth(pool, 'rpc_unhealthy', 'solana', false, 'rpc');
    await observeHealth(pool, 'rpc_unhealthy', 'solana', true, 'malformed');
    expect(await events()).toEqual(['opened', 'resolved', 'opened']);
    for (const sql of [
      "UPDATE monitoring_events SET code = 'rpc'",
      'DELETE FROM monitoring_events',
      'TRUNCATE monitoring_events CASCADE',
    ])
      await expect(pool.query(sql)).rejects.toThrow(/append-only/);
  });

  it('audits direct order inserts, updates and vetoes atomically without arbitrary reason text', async () => {
    const id = await bot();
    await pool.query('INSERT INTO tokens(mint, decimals) VALUES($1, 9)', [MINT]);
    const insert = `INSERT INTO orders(client_order_id, bot_id, token_mint, side, mode, amount_in_raw, max_slippage_bps, reason)
      VALUES($1, $2, $3, 'buy', 'paper', 100, 100, 'credential://do-not-copy') RETURNING id`;
    const result = await withTransaction(pool, async (db) => {
      await setAuditActor(db, 'owner');
      return db.query<{ id: string }>(insert, ['first', id, MINT]);
    });
    const orderId = result.rows[0]!.id;
    await pool.query(
      "UPDATE orders SET status = 'vetoed', veto_reason = 'Bearer secret-value', failure_reason = 'https://secret.example/key' WHERE id = $1",
      [orderId],
    );
    await pool.query("UPDATE orders SET veto_reason = 'risk_limit' WHERE id = $1", [orderId]);
    const audits = (
      await pool.query(
        "SELECT actor, action, details FROM audit_log WHERE entity_type = 'orders' ORDER BY id",
      )
    ).rows;
    expect(audits.map((x) => x.action)).toEqual(['order.created', 'order.vetoed', 'order.vetoed']);
    expect(audits[0]?.actor).toBe('owner');
    expect(audits[1]?.actor).toBe('system/database');
    expect(audits[1]?.details.reason_category).toBe('unspecified');
    expect(audits[2]?.details.reason_category).toBe('risk_limit');
    expect(JSON.stringify(audits)).not.toMatch(/secret|Bearer|credential/);
    await expect(
      withTransaction(pool, async (db) => {
        await db.query(insert, ['rolled-back', id, MINT]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      (await pool.query("SELECT id FROM orders WHERE client_order_id = 'rolled-back'")).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT id FROM audit_log WHERE entity_type = 'orders'")).rowCount,
    ).toBe(3);
    // Audit failure is a business mutation failure, even for raw SQL callers.
    await pool.query(`CREATE FUNCTION fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$;
      CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit_insert()`);
    await expect(pool.query(insert, ['audit-failure', id, MINT])).rejects.toThrow(
      'audit unavailable',
    );
    expect(
      (await pool.query("SELECT id FROM orders WHERE client_order_id = 'audit-failure'")).rowCount,
    ).toBe(0);
  });

  it('audits policy changes with safe fields and preserves append-only enforcement', async () => {
    const id = await bot();
    await pool.query(
      'UPDATE bots SET paper_bankroll_lamports = 5, strategy_params = $2 WHERE id = $1',
      [id, JSON.stringify({ password: 'arbitrary-secret', endpoint: 'https://token.example' })],
    );
    await pool.query(
      'UPDATE risk_profiles SET position_fraction = .03, take_profit_ladder = \'[{"atGain":1,"sellFraction":0.5}]\' WHERE id = \'test_profile\'',
    );
    await pool.query(
      "INSERT INTO wallets(label,public_key,spend_cap_lamports) VALUES('arbitrary-secret', $1, 10)",
      [MINT],
    );
    await pool.query('UPDATE wallets SET spend_cap_lamports = 20 WHERE public_key = $1', [MINT]);
    const audits = (
      await pool.query(
        "SELECT action, details FROM audit_log WHERE action = 'config.changed' ORDER BY id",
      )
    ).rows;
    expect(audits).toHaveLength(3);
    expect(audits[0]?.details.after).toMatchObject({
      paper_bankroll_lamports: 5,
      strategy_params_changed: true,
    });
    expect(audits[1]?.details.after.take_profit_ladder).toEqual([{ atGain: 1, sellFraction: 0.5 }]);
    expect(JSON.stringify(audits)).not.toMatch(/arbitrary-secret|password|https:/);
    const projection = await pool.query<{ policy: { take_profit_ladder: unknown } }>(
      "SELECT audit_safe_policy('risk_profiles', $1::jsonb) AS policy",
      [
        JSON.stringify({
          take_profit_ladder: [{ atGain: 1, sellFraction: 0.5, password: 'arbitrary-secret' }],
        }),
      ],
    );
    expect(projection.rows[0]!.policy.take_profit_ladder).toEqual([
      { atGain: 1, sellFraction: 0.5 },
    ]);
    expect(JSON.stringify(projection.rows)).not.toContain('arbitrary-secret');
    for (const sql of [
      "UPDATE audit_log SET actor = 'changed'",
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
    ])
      await expect(pool.query(sql)).rejects.toThrow(/append-only/);
  });

  it('durably audits boot and only changed nonsecret startup policy; secret/provider edits do not produce config changes', async () => {
    const config = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      SOLANA_RPC_URL: 'https://rpc.example/?key=synthetic-provider-secret',
    });
    await auditStartup(pool, 'engine', config);
    await auditStartup(pool, 'engine', config);
    await auditStartup(
      pool,
      'engine',
      loadConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        SOLANA_RPC_URL: 'https://rpc.example/?key=different-secret',
      }),
    );
    expect(
      (await pool.query("SELECT id FROM audit_log WHERE action = 'config.changed'")).rowCount,
    ).toBe(0);
    await auditStartup(
      pool,
      'engine',
      loadConfig({ DATABASE_URL: TEST_DATABASE_URL, BOT_WATCHLIST_SIZE: '5' }),
    );
    const rows = (
      await pool.query(
        "SELECT action, details FROM audit_log WHERE entity_type = 'runtime' ORDER BY id",
      )
    ).rows;
    expect(rows.map((x) => x.action)).toEqual([
      'runtime.boot',
      'runtime.boot',
      'runtime.boot',
      'config.changed',
      'runtime.boot',
    ]);
    expect(JSON.stringify(rows)).not.toMatch(
      /provider-secret|different-secret|rpc.example|postgres/,
    );
    await pool.query('DROP TABLE runtime_config_snapshots');
    await expect(auditStartup(pool, 'engine', config)).rejects.toThrow();
  });

  it('actual engine startup acquires persisted bots, audits boot, publishes scaffold progress and releases on SIGTERM', async () => {
    const id = await bot();
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=@memebots/source',
        fileURLToPath(new URL('../../../apps/engine/src/main.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { DATABASE_URL: TEST_DATABASE_URL },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      await expect.poll(() => output).toContain('engine started in paper mode');
      await expect
        .poll(
          async () =>
            (await pool.query('SELECT heartbeat_at FROM bot_heartbeats WHERE bot_id = $1', [id]))
              .rows[0].heartbeat_at,
        )
        .not.toBeNull();
      expect(
        (await pool.query("SELECT id FROM audit_log WHERE action = 'runtime.boot'")).rowCount,
      ).toBe(1);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(
        (await pool.query('SELECT expected FROM bot_heartbeats WHERE bot_id = $1', [id])).rows[0]
          .expected,
      ).toBe(false);
      expect(output).toContain('engine stopped');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('monitoring down/up keeps canonical audit history and rebuilds expectations for persisted bots', async () => {
    await bot();
    const count = (await pool.query('SELECT count(*) FROM audit_log')).rows[0].count;
    const later = (await loadMigrations()).filter((m) => m.version > '0012');
    await migrateDown(pool, later.length + 1);
    expect((await pool.query('SELECT count(*) FROM audit_log')).rows[0].count).toBe(count);
    await migrateUp(pool);
    expect((await pool.query('SELECT * FROM bot_heartbeats')).rowCount).toBe(1);
  });
});

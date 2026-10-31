import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../../apps/api/src/server.js';
import { migrateDown, migrateUp } from './migrate.js';
import { createPool } from './pool.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';
import { createOfflineVault } from './wallet-management/vault.js';
import type { OfflineVault } from './wallet-management/vault.js';
import { prepareWallet } from './wallet-management/prepare.js';
import {
  createControlledBot,
  getControlledBot,
  listPreparedWallets,
  transitionControlledBot,
  updateControlledBot,
} from './bot-control.js';
import { registerPaperIntent, preparePaperAttempt, settlePaperAttempt } from './paper-execution.js';
import type { ApprovedOrderIntent, ExecutionResult, PaperModel } from '@memebots/core';
import { PaperBroker } from '../../../apps/engine/src/paper/broker.js';
import { normalizeJupiterQuote } from '../../../apps/engine/src/paper/quote.js';
import { drawModel } from '../../../apps/engine/src/paper/model.js';

/** Both broker versions must fence off-mode work: older rejects, integrated persists zero cancellation. */
async function expectOffFencedOutcome(work: Promise<ExecutionResult>): Promise<void> {
  const outcome = await work.then(
    (result) => ({ kind: 'result' as const, result }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  if (outcome.kind === 'rejected') {
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).toHaveProperty('message', 'PERSISTED_ORDER_MISMATCH');
  } else {
    expect(outcome.result).toMatchObject({
      status: 'cancelled',
      reason: 'EXIT_AUTHORITY_OR_MODE_REVOKED',
      inputRaw: '0',
      outputRaw: '0',
      networkFeeLamports: '0',
      priorityFeeLamports: '0',
    });
  }
}

describe.skipIf(!hasTestDatabase)('local bot control with genuine offline preparation', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  const dirs: string[] = [];
  let vault: OfflineVault, key: Buffer;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bot-control-test-')));
    dirs.push(dir);
    vault = await createOfflineVault(join(dir, 'vault'));
    key = randomBytes(32);
  });
  afterAll(async () => {
    await pool.end();
    key?.fill(0);
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });
  async function prepared() {
    return prepareWallet(pool, {
      walletId: randomUUID(),
      label: 'Disposable test wallet',
      spendCapLamports: 900719925474099312345n,
      vault,
      encryptionKey: key,
    });
  }
  async function bot(name = 'Paper observer') {
    const w = await prepared();
    return createControlledBot(pool, {
      name,
      strategy: 'momentum',
      strategyParams: {},
      riskProfileId: 'balanced',
      walletId: w.id,
      paperBankrollLamports: '900719925474099312345',
    });
  }
  it('persists exact initial cash, claims once, rejects unsafe fields, safely audits name and profile', async () => {
    const b = await bot();
    expect(b.paperBankrollLamports).toBe('900719925474099312345');
    expect(b.spendCapLamports).toBe('900719925474099312345');
    expect(b.observedBalanceLamports).toBeNull();
    expect(await listPreparedWallets(pool)).toEqual([]);
    const updated = await updateControlledBot(pool, b.id, {
      name: 'synthetic-name-never-audited',
      strategy: 'dip_buy',
      strategyParams: {},
      riskProfileId: 'conservative',
      revision: b.revision,
    });
    expect(updated.revision).not.toBe(b.revision);
    const audit = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    expect(audit).toContain('nameChanged');
    expect(audit).toContain('risk_profile_id');
    expect(audit).not.toContain('synthetic-name-never-audited');
    expect(audit).not.toContain(key.toString('base64'));
    await expect(
      updateControlledBot(pool, b.id, {
        name: 'stale',
        strategy: 'momentum',
        strategyParams: {},
        riskProfileId: 'balanced',
        revision: b.revision,
      }),
    ).rejects.toThrow('STALE_REVISION');
    for (const extra of [
      { mode: 'live' },
      { walletId: randomUUID() },
      { paperBankrollLamports: '1' },
      { privateKey: 'never-store' },
    ])
      await expect(
        updateControlledBot(pool, b.id, {
          name: updated.name,
          strategy: updated.strategy,
          strategyParams: {},
          riskProfileId: updated.riskProfileId,
          revision: updated.revision,
          ...extra,
        }),
      ).rejects.toThrow('INVALID_FIELDS');
    const fresh = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      expect((await getControlledBot(fresh, b.id)).name).toBe(updated.name);
    } finally {
      await fresh.end();
    }
  });
  it('preserves exact nonempty legacy JSON across rename/profile edits and rejects parameter loss', async () => {
    for (const strategy of ['legacy_strategy', 'momentum']) {
      const b = await bot(`Original ${strategy}`);
      await pool.query(
        `UPDATE bots SET strategy=$2,strategy_params='{"watchlist":["public-mint"],"lookbackMinutes":45,"precision":0.123456789012345678901234567890}'::jsonb WHERE id=$1`,
        [b.id, strategy],
      );
      const before = await getControlledBot(pool, b.id),
        stored = (
          await pool.query('SELECT strategy_params::text value FROM bots WHERE id=$1', [b.id])
        ).rows[0].value;
      let current = await updateControlledBot(pool, b.id, {
        name: `Renamed ${strategy}`,
        strategy,
        riskProfileId: 'conservative',
        revision: before.revision,
      });
      expect(
        (await pool.query('SELECT strategy_params::text value FROM bots WHERE id=$1', [b.id]))
          .rows[0].value,
      ).toBe(stored);
      // Older panel clients may still send the empty placeholder; it must not erase saved configuration.
      current = await updateControlledBot(pool, b.id, {
        name: `Renamed twice ${strategy}`,
        strategy,
        riskProfileId: 'balanced',
        strategyParams: {},
        revision: current.revision,
      });
      expect(
        (await pool.query('SELECT strategy_params::text value FROM bots WHERE id=$1', [b.id]))
          .rows[0].value,
      ).toBe(stored);
      await expect(
        updateControlledBot(pool, b.id, {
          name: current.name,
          strategy,
          riskProfileId: 'balanced',
          strategyParams: { newUnknownParameter: 1 },
          revision: current.revision,
        }),
      ).rejects.toThrow('STRATEGY_PARAMETERS_UNAVAILABLE');
      await expect(
        updateControlledBot(pool, b.id, {
          name: current.name,
          strategy: 'sniper',
          riskProfileId: 'balanced',
          strategyParams: {},
          revision: current.revision,
        }),
      ).rejects.toThrow('LEGACY_PARAMETERS_REQUIRE_OFFLINE_REVIEW');
      expect(
        (await pool.query('SELECT strategy_params::text value FROM bots WHERE id=$1', [b.id]))
          .rows[0].value,
      ).toBe(stored);
      expect((await getControlledBot(pool, b.id)).revision).toBe(current.revision);
    }
  });
  it('serializes two claims and rolls back failed create without claiming wallet', async () => {
    const w = await prepared();
    const payload = {
      strategy: 'momentum',
      strategyParams: {},
      riskProfileId: 'balanced',
      walletId: w.id,
      paperBankrollLamports: '0',
    };
    const race = await Promise.allSettled([
      createControlledBot(pool, { ...payload, name: 'one' }),
      createControlledBot(pool, { ...payload, name: 'two' }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const spare = await prepared();
    const winner = (
      race.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof bot>>
      >
    ).value;
    const before = (await pool.query('SELECT count(*)::int count FROM audit_log')).rows[0].count;
    await expect(
      createControlledBot(pool, { ...payload, name: winner.name, walletId: spare.id }),
    ).rejects.toThrow('CONFIGURATION_CONFLICT');
    expect((await listPreparedWallets(pool)).map((w) => w.id)).toContain(spare.id);
    expect((await pool.query('SELECT count(*)::int count FROM audit_log')).rows[0].count).toBe(
      before,
    );
  });
  it('recovers offline preparation after DB failure with the same encrypted file and denies foreign key', async () => {
    const id = randomUUID(),
      opts = {
        walletId: id,
        label: 'Recovery wallet',
        spendCapLamports: 1n,
        vault,
        encryptionKey: key,
      };
    const original = await vault.provision(id, key);
    const result = await prepareWallet(pool, opts);
    expect(result.publicKey).toBe(original);
    expect(await prepareWallet(pool, opts)).toEqual(result);
    expect(await prepareWallet(pool, { ...opts, walletId: id.toUpperCase() })).toEqual(result);
    expect(await vault.listIds()).toEqual([id]);
    await expect(prepareWallet(pool, { ...opts, encryptionKey: randomBytes(32) })).rejects.toThrow(
      'VAULT_UNAVAILABLE',
    );
    await expect(prepareWallet(pool, { ...opts, label: 'different' })).rejects.toThrow(
      'RETRY_MISMATCH',
    );
  });
  it('never generates a replacement for missing committed vault material; restores and retries on max-one pool', async () => {
    const single = createPool(TEST_DATABASE_URL, { max: 1, timeoutMs: 5000 });
    try {
      const id = randomUUID(),
        opts = {
          walletId: id,
          label: 'Original identity',
          spendCapLamports: 100n,
          vault,
          encryptionKey: key,
        };
      const original = await prepareWallet(single, opts),
        dir = dirs.at(-1)!,
        file = join(dir, 'vault', `${id}.vault.json`),
        backup = join(dir, 'original-backup');
      await rename(file, backup);
      await expect(prepareWallet(single, opts)).rejects.toThrow('ORIGINAL_VAULT_RESTORE_REQUIRED');
      expect(await vault.listIds()).toEqual([]);
      expect(
        (await pool.query('SELECT public_key FROM wallets WHERE id=$1', [id])).rows[0].public_key,
      ).toBe(original.publicKey);
      await rename(backup, file);
      expect(await prepareWallet(single, opts)).toEqual(original);
      expect(await vault.publicKey(id, key)).toBe(original.publicKey);
      const raced = await Promise.all([prepareWallet(single, opts), prepareWallet(single, opts)]);
      expect(raced).toEqual([original, original]);
      const newOpts = { ...opts, walletId: randomUUID(), label: 'Concurrent prepared identity' };
      const concurrent = await Promise.all([
        prepareWallet(pool, newOpts),
        prepareWallet(pool, newOpts),
      ]);
      expect(concurrent[0]).toEqual(concurrent[1]);
      expect(
        (
          await pool.query('SELECT count(*)::int count FROM wallets WHERE id=$1', [
            newOpts.walletId,
          ])
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await single.end();
    }
  });
  it('keeps legacy unprepared wallets ineligible and supports migration down/up', async () => {
    const b = await bot();
    await migrateDown(pool, 1);
    await migrateUp(pool);
    expect(await listPreparedWallets(pool)).toEqual([]);
    expect((await getControlledBot(pool, b.id)).name).toBe(b.name);
  });
  it('off cancels pending orders and leaves positions open; paper restores monitor eligibility', async () => {
    const b = await bot();
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9)', [mint]);
    await pool.query(
      `INSERT INTO positions(bot_id,token_mint,mode,entry_price_sol,quantity_raw,remaining_raw,cost_lamports,stop_price_sol,high_water_price_sol) VALUES($1,$2,'paper',1,100,100,100,0.8,1)`,
      [b.id, mint],
    );
    await pool.query(
      `INSERT INTO orders(client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES('pending',$1,$2,'buy','paper',1,300,'manual_paper_scenario')`,
      [b.id, mint],
    );
    await expect(
      updateControlledBot(pool, b.id, {
        name: b.name,
        strategy: b.strategy,
        strategyParams: {},
        riskProfileId: b.riskProfileId,
        revision: b.revision,
      }),
    ).rejects.toThrow('PENDING_ORDERS');
    const off = await transitionControlledBot(pool, b.id, { mode: 'off', revision: b.revision });
    expect(off.openPositions).toBe(1);
    expect(off.pendingOrders).toBe(0);
    expect((await pool.query('SELECT status FROM orders')).rows[0].status).toBe('cancelled');
    expect(
      (await pool.query('SELECT expected FROM bot_heartbeats WHERE bot_id=$1', [b.id])).rows[0]
        .expected,
    ).toBe(false);
    const paper = await transitionControlledBot(pool, b.id, {
      mode: 'paper',
      revision: off.revision,
    });
    expect(paper.openPositions).toBe(1);
    expect(paper.pendingOrders).toBe(0);
    expect(
      (await pool.query('SELECT expected FROM bot_heartbeats WHERE bot_id=$1', [b.id])).rows[0]
        .expected,
    ).toBe(true);
  });
  it('fences settlement after off and runs with a single pooled connection', async () => {
    const b = await bot();
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9)', [mint]);
    const id = randomUUID(),
      now = Date.now();
    const intent: ApprovedOrderIntent = {
      orderId: id,
      clientOrderId: `test:${id}`,
      botId: b.id,
      positionId: null,
      tokenMint: mint,
      side: 'buy',
      mode: 'paper',
      amountInRaw: '100',
      maxSlippageBps: 300,
      expiresAt: now + 60000,
      approval: { kind: 'manual_paper_scenario', reference: 'owner-test' },
      quoteRequirements: {
        freshnessPolicy: 'bounded_request_age',
        maxAgeMs: 5000,
        maxSlotLag: 20,
        fullyObservedCosts: false,
      },
      entry: { stopPriceSol: '0.8', takeProfit: [{ atGain: 0.3, sellFraction: 0.5 }] },
      closeReason: null,
    };
    await pool.query(
      `INSERT INTO orders(id,client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,'buy','paper',100,300,'manual_paper_scenario')`,
      [id, intent.clientOrderId, b.id, mint],
    );
    const single = createPool(TEST_DATABASE_URL, { max: 1, timeoutMs: 5000 });
    try {
      await registerPaperIntent(single, intent);
      const model: PaperModel = {
        version: 'paper-v1',
        minLatencyMs: 0,
        maxLatencyMs: 0,
        adverseSlippageBps: 0,
        failureProbability: 0,
        failureStage: 'submitted',
        partialFillBps: 10000,
        fees: {
          provenance: 'MODEL',
          selectedBy: 'test-owner',
          networkLamports: '0',
          priorityLamports: '0',
        },
      };
      const attempt = await preparePaperAttempt(
        single,
        intent,
        'attempt',
        model,
        'a'.repeat(64),
        drawModel('a'.repeat(64), model),
        now,
      );
      await transitionControlledBot(single, b.id, { mode: 'off', revision: b.revision });
      await expectOffFencedOutcome(
        settlePaperAttempt(single, attempt, {
          attemptId: attempt.id,
          orderId: id,
          status: 'filled',
          reason: 'SIMULATED_FILL',
          inputRaw: '100',
          outputRaw: '100',
          networkFeeLamports: '0',
          priorityFeeLamports: '0',
          costsProvenance: 'MODEL',
        }),
      );
      expect((await getControlledBot(pool, b.id)).paperBankrollLamports).toBe(
        b.paperBankrollLamports,
      );
      expect((await pool.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status).toBe(
        'cancelled',
      );
      expect((await pool.query('SELECT count(*)::int count FROM fills')).rows[0].count).toBe(0);
    } finally {
      await single.end();
    }
  });
  it('serializes real broker fill versus off, including max-one pool reentry', async () => {
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      sol = 'So11111111111111111111111111111111111111112';
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9)', [mint]);
    const single = createPool(TEST_DATABASE_URL, { max: 1, timeoutMs: 5000 });
    try {
      for (const offBeforeFill of [false, true]) {
        const b = await bot(`Race ${offBeforeFill}`),
          id = randomUUID();
        let now = Date.now();
        const intent: ApprovedOrderIntent = {
          orderId: id,
          clientOrderId: `test:${id}`,
          botId: b.id,
          positionId: null,
          tokenMint: mint,
          side: 'buy',
          mode: 'paper',
          amountInRaw: '100',
          maxSlippageBps: 300,
          expiresAt: now + 60000,
          approval: { kind: 'manual_paper_scenario', reference: 'owner-test' },
          quoteRequirements: {
            freshnessPolicy: 'bounded_request_age',
            maxAgeMs: 5000,
            maxSlotLag: 20,
            fullyObservedCosts: false,
          },
          entry: { stopPriceSol: '0.4', takeProfit: [{ atGain: 0.3, sellFraction: 0.5 }] },
          closeReason: null,
        };
        await pool.query(
          `INSERT INTO orders(id,client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,'buy','paper',100,300,'manual_paper_scenario')`,
          [id, intent.clientOrderId, b.id, mint],
        );
        await registerPaperIntent(single, intent);
        const model: PaperModel = {
          version: 'paper-v1',
          minLatencyMs: 10,
          maxLatencyMs: 10,
          adverseSlippageBps: 0,
          failureProbability: 0,
          failureStage: 'submitted',
          partialFillBps: 10000,
          fees: {
            provenance: 'MODEL',
            selectedBy: 'test-owner',
            networkLamports: '0',
            priorityLamports: '0',
          },
        };
        const broker = new PaperBroker(
          single,
          {
            quote: async (request) => ({
              status: 'available',
              quote: normalizeJupiterQuote(
                {
                  router: 'metis',
                  transaction: null,
                  inputMint: sol,
                  outputMint: mint,
                  inAmount: request.inputRaw,
                  outAmount: '200',
                  otherAmountThreshold: '194',
                  swapMode: 'ExactIn',
                  slippageBps: 300,
                  gasless: false,
                  taker: null,
                  feeBps: 0,
                  feeMint: sol,
                  platformFee: { amount: '0', feeBps: 0, feeMint: sol },
                  routePlan: [
                    {
                      bps: 10000,
                      swapInfo: {
                        ammKey: mint,
                        inputMint: sol,
                        outputMint: mint,
                        inAmount: request.inputRaw,
                        outAmount: '200',
                      },
                    },
                  ],
                },
                request,
                now,
                now,
                true,
              ),
            }),
            currentContext: async () => ({ slot: 101, blockTimeMs: now - 1, observedAt: now }),
          },
          model,
          {
            clock: () => now,
            monotonicClock: () => now,
            seed: () => 'a'.repeat(64),
            sleep: async (ms) => {
              if (offBeforeFill)
                await transitionControlledBot(single, b.id, { mode: 'off', revision: b.revision });
              now += ms;
            },
          },
        );
        if (offBeforeFill) {
          await expectOffFencedOutcome(broker.execute(intent, `race:${id}`));
          expect(
            (await pool.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status,
          ).toBe('cancelled');
          expect((await getControlledBot(pool, b.id)).paperBankrollLamports).toBe(
            b.paperBankrollLamports,
          );
        } else {
          expect((await broker.execute(intent, `race:${id}`)).status).toBe('filled');
          const off = await transitionControlledBot(single, b.id, {
            mode: 'off',
            revision: b.revision,
          });
          expect(off.openPositions).toBe(1);
          expect(off.paperBankrollLamports).toBe(
            (BigInt(b.paperBankrollLamports) - 100n).toString(),
          );
        }
        expect(
          (await pool.query('SELECT count(*)::int count FROM fills WHERE order_id=$1', [id]))
            .rows[0].count,
        ).toBe(offBeforeFill ? 0 : 1);
      }
    } finally {
      await single.end();
    }
  });
  it('runs session-authenticated API prepare/create/edit/off/paper and rejects live even with confirmation', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bot-control-cli-')));
    dirs.push(dir);
    const metadata = {
      walletId: randomUUID(),
      label: 'CLI to API wallet',
      spendCapLamports: '2000000000',
      vaultDirectory: join(dir, 'vault'),
    };
    const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--conditions=@memebots/source',
            fileURLToPath(new URL('./wallet-management/cli.ts', import.meta.url)),
            'prepare',
          ],
          {
            env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
        child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin!.end(JSON.stringify(metadata));
        (child.stdio[3] as Writable).end(key);
      },
    );
    expect(cli.code).toBe(0);
    expect(cli.stdout + cli.stderr).not.toContain(key.toString('base64'));
    expect(cli.stdout + cli.stderr).not.toContain(key.toString('hex'));
    const wallet = JSON.parse(cli.stdout) as { id: string };
    const app = buildServer({ mode: 'paper', control: { pool } });
    const base = {
      host: '127.0.0.1:3001',
      origin: 'http://127.0.0.1:5173',
      'sec-fetch-site': 'same-origin',
    };
    try {
      const session = await app.inject({ url: '/control/session', headers: base });
      expect(session.statusCode).toBe(200);
      const cookie = session.headers['set-cookie']!.toString().split(';')[0]!;
      const headers = {
        ...base,
        cookie,
        'content-type': 'application/json',
        'x-local-csrf': session.json().csrfToken as string,
      };
      expect((await app.inject({ url: '/control', headers })).json().wallets[0].id).toBe(wallet.id);
      const created = await app.inject({
        method: 'POST',
        url: '/control/bots',
        headers,
        payload: {
          name: 'API paper bot',
          strategy: 'dca_grid',
          strategyParams: {},
          riskProfileId: 'conservative',
          walletId: wallet.id,
          paperBankrollLamports: '900719925474099312345',
        },
      });
      expect(created.statusCode).toBe(201);
      let b = created.json();
      const edited = await app.inject({
        method: 'PUT',
        url: `/control/bots/${b.id}`,
        headers,
        payload: {
          name: 'API revised',
          strategy: 'sniper',
          strategyParams: {},
          riskProfileId: 'balanced',
          revision: b.revision,
        },
      });
      expect(edited.statusCode).toBe(200);
      b = edited.json();
      for (const mode of ['off', 'paper']) {
        const res = await app.inject({
          method: 'POST',
          url: `/control/bots/${b.id}/mode`,
          headers,
          payload: { mode, revision: b.revision },
        });
        expect(res.statusCode).toBe(200);
        b = res.json();
        expect(b.mode).toBe(mode);
      }
      const live = await app.inject({
        method: 'POST',
        url: `/control/bots/${b.id}/mode`,
        headers,
        payload: {
          mode: 'live',
          revision: b.revision,
          confirmation: 'I understand live trading risks',
        },
      });
      expect(live.statusCode).toBe(409);
      expect(live.json().code).toBe('LIVE_EXECUTOR_UNAVAILABLE');
      expect((await getControlledBot(pool, b.id)).mode).toBe('paper');
      expect(
        (await pool.query("SELECT details FROM audit_log WHERE action='bot.mode_refused'")).rows[0]
          .details.reason,
      ).toBe('LIVE_EXECUTOR_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });
});

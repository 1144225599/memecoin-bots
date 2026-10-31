import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovedOrderIntent, PaperModel } from '@memebots/core';
import { PositionExitManager } from '../../../apps/engine/src/exits/manager.js';
import { RiskManager, createRiskPaperBroker } from '../../../apps/engine/src/risk/manager.js';
import { goodScenario, fixtureAddress } from '../../../apps/engine/src/safety/fixtures.js';
import { PaperBroker } from '../../../apps/engine/src/paper/broker.js';
import { normalizeJupiterQuote } from '../../../apps/engine/src/paper/quote.js';
import type { PaperQuoteProvider, QuoteRequest } from '../../../apps/engine/src/paper/quote.js';
import {
  createControlledBot,
  getControlledBot,
  transitionControlledBot,
  updateControlledBot,
} from './bot-control.js';
import { migrateUp } from './migrate.js';
import { SafetyStore } from './safety.js';
import { riskExposure, setPaperRiskCap } from './risk-admission.js';
import { registerPaperIntent } from './paper-execution.js';
import { createPool } from './pool.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';
import { createOfflineVault } from './wallet-management/vault.js';
import { prepareWallet } from './wallet-management/prepare.js';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
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
    selectedBy: 'combined-owner-test',
    networkLamports: '0',
    priorityLamports: '0',
  },
};
function quote(request: QuoteRequest, numerator = 2n, denominator = 1n) {
  const inputMint = request.intent.side === 'buy' ? SOL : MINT,
    outputMint = request.intent.side === 'buy' ? MINT : SOL;
  const output = (BigInt(request.inputRaw) * numerator) / denominator;
  const json = {
    router: 'metis',
    transaction: null,
    inputMint,
    outputMint,
    inAmount: request.inputRaw,
    outAmount: output.toString(),
    otherAmountThreshold: (
      (output * BigInt(10000 - request.intent.maxSlippageBps) + 9999n) /
      10000n
    ).toString(),
    swapMode: 'ExactIn',
    slippageBps: request.intent.maxSlippageBps,
    gasless: false,
    taker: null,
    feeBps: 0,
    feeMint: inputMint,
    platformFee: { amount: '0', feeBps: 0, feeMint: inputMint },
    routePlan: [
      {
        bps: 10000,
        percent: 100,
        swapInfo: {
          ammKey: MINT,
          inputMint,
          outputMint,
          inAmount: request.inputRaw,
          outAmount: output.toString(),
        },
      },
    ],
  };
  const now = Date.now();
  return {
    status: 'available' as const,
    quote: normalizeJupiterQuote(json, request, now, now, true),
  };
}
describe.skipIf(!hasTestDatabase)('combined exit and bot control lifecycle', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
  });
  afterAll(async () => pool.end());
  it.each([false, true])(
    'offline prepare -> controlled paper bot -> owner entry -> exit -> off/profile/paper -> protective exit (off races sell=%s)',
    async (offRacesSell) => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'combined-bot-exit-'))),
        key = randomBytes(32);
      const single = createPool(TEST_DATABASE_URL, { max: 1, timeoutMs: 5000 });
      try {
        const vault = await createOfflineVault(join(dir, 'vault'));
        const wallet = await prepareWallet(single, {
          walletId: randomUUID(),
          label: 'Disposable combined wallet',
          spendCapLamports: 10000000000n,
          vault,
          encryptionKey: key,
        });
        const bot = await createControlledBot(single, {
          name: `Combined ${offRacesSell}`,
          strategy: 'momentum',
          strategyParams: {},
          riskProfileId: 'balanced',
          walletId: wallet.id,
          paperBankrollLamports: '10000000000',
        });
        await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9)', [MINT]);
        const id = randomUUID();
        const intent: ApprovedOrderIntent = {
          orderId: id,
          clientOrderId: `combined:${id}`,
          botId: bot.id,
          positionId: null,
          tokenMint: MINT,
          side: 'buy',
          mode: 'paper',
          amountInRaw: '1000000000',
          maxSlippageBps: 300,
          expiresAt: Date.now() + 60000,
          approval: { kind: 'manual_paper_scenario', reference: 'combined-owner-test' },
          quoteRequirements: {
            freshnessPolicy: 'bounded_request_age',
            maxAgeMs: 5000,
            maxSlotLag: 0,
            fullyObservedCosts: false,
          },
          entry: {
            stopPriceSol: '0.4',
            takeProfit: [
              { atGain: 0.3, sellFraction: 0.4 },
              { atGain: 0.6, sellFraction: 0.3 },
            ],
          },
          closeReason: null,
        };
        await pool.query(
          "INSERT INTO orders(id,client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,'buy','paper',$5,300,'OWNER_COMBINED_TEST')",
          [id, intent.clientOrderId, bot.id, MINT, intent.amountInRaw],
        );
        await registerPaperIntent(single, intent);
        const source: PaperQuoteProvider = {
          quote: async (request) => quote(request),
          currentContext: async () => undefined,
        };
        expect(
          (await new PaperBroker(single, source, model).execute(intent, 'combined-entry')).status,
        ).toBe('filled');
        const position = (
          await pool.query<{ id: string }>('SELECT id FROM positions WHERE bot_id=$1', [bot.id])
        ).rows[0]!.id;
        const savedPolicy = (
          await pool.query('SELECT policy FROM position_exit_policies WHERE position_id=$1', [
            position,
          ])
        ).rows[0]!.policy;
        let quoteCalls = 0;
        const racing: PaperQuoteProvider = {
          ...source,
          quote: async (request) => {
            if (++quoteCalls === 2 && offRacesSell) {
              const current = await getControlledBot(single, bot.id);
              await transitionControlledBot(single, bot.id, {
                mode: 'off',
                revision: current.revision,
              });
            }
            return quote(request);
          },
        };
        const first = (await new PositionExitManager(single, racing).once({ botId: bot.id }))[0]!;
        expect(first.result?.status).toBe(offRacesSell ? 'cancelled' : 'filled');
        if (offRacesSell) {
          expect(first.result?.inputRaw).toBe('0');
          expect(first.result?.networkFeeLamports).toBe('0');
        }
        let current = await getControlledBot(single, bot.id);
        if (!offRacesSell)
          current = await transitionControlledBot(single, bot.id, {
            mode: 'off',
            revision: current.revision,
          });
        expect(current.openPositions).toBe(1);
        expect(current.pendingOrders).toBe(0);
        expect(await new PositionExitManager(single, source).once({ botId: bot.id })).toEqual([]);
        current = await updateControlledBot(single, bot.id, {
          name: current.name,
          strategy: current.strategy,
          riskProfileId: 'conservative',
          revision: current.revision,
        });
        expect(
          (
            await pool.query('SELECT policy FROM position_exit_policies WHERE position_id=$1', [
              position,
            ])
          ).rows[0]!.policy,
        ).toEqual(savedPolicy);
        await transitionControlledBot(single, bot.id, {
          mode: 'paper',
          revision: current.revision,
        });
        await pool.query(
          "UPDATE position_exit_state SET retry_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE position_id=$1",
          [position],
        );
        const final = (
          await new PositionExitManager(single, {
            ...source,
            quote: async (request) => quote(request, 1n, 10n),
          }).once({ botId: bot.id })
        )[0]!;
        expect(final.result?.status).toBe('filled');
        const state = (
          await pool.query(
            'SELECT p.status,p.close_reason,p.remaining_raw,s.original_raw,s.filled_steps FROM positions p JOIN position_exit_state s ON s.position_id=p.id WHERE p.id=$1',
            [position],
          )
        ).rows[0]!;
        expect(state).toMatchObject({
          status: 'closed',
          close_reason: 'stop_loss',
          remaining_raw: '0',
          original_raw: '2000000000',
          filled_steps: offRacesSell ? ['0', '0'] : ['800000000', '600000000'],
        });
        expect((await pool.query('SELECT count(*)::integer n FROM fills')).rows[0]!.n).toBe(
          offRacesSell ? 2 : 3,
        );
        expect(single.waitingCount).toBe(0);
      } finally {
        await single.end();
        key.fill(0);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(['exit', 'off'] as const)(
    'risk signal -> partial entry -> %s fence -> off/resume preserves reservations, cap and exact accounting at pool max1',
    async (firstFence) => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'combined-risk-exit-'))),
        key = randomBytes(32);
      const single = createPool(TEST_DATABASE_URL, { max: 1, timeoutMs: 5000 });
      const initialCash = 10000000000n;
      try {
        const vault = await createOfflineVault(join(dir, 'vault'));
        const wallet = await prepareWallet(single, {
          walletId: randomUUID(),
          label: 'Disposable risk integration wallet',
          spendCapLamports: initialCash,
          vault,
          encryptionKey: key,
        });
        const bot = await createControlledBot(single, {
          name: `All three ${firstFence}`,
          strategy: 'momentum',
          strategyParams: {},
          riskProfileId: 'balanced',
          walletId: wallet.id,
          paperBankrollLamports: initialCash.toString(),
        });
        await setPaperRiskCap(single, bot.id, initialCash.toString());
        const evidence = goodScenario();
        evidence.mint = MINT;
        evidence.decimals = 9;
        evidence.checks.sell.facts!.mint = MINT;
        evidence.checks.holders.facts!.developerOwner = fixtureAddress(60);
        const store = new SafetyStore(single),
          cacheKey = `solana:${MINT}:none`,
          lease = await store.acquire(cacheKey);
        if (!lease) throw new Error('SAFETY_LEASE_REQUIRED');
        await store.save({
          key: cacheKey,
          mint: MINT,
          evidence,
          expiresAt: evidence.checks.mintAuthority.expiresAt,
          refreshMs: 60000,
          lease,
        });
        await single.query(
          'INSERT INTO tokens(mint,decimals) VALUES($1,9) ON CONFLICT DO NOTHING',
          [MINT],
        );
        const entryModel: PaperModel = {
          ...model,
          partialFillBps: 5000,
          fees: { ...model.fees, networkLamports: '5000' },
        };
        const source: PaperQuoteProvider = {
          quote: async (request) => quote(request),
          currentContext: async () => undefined,
        };
        const manager = new RiskManager(single, source, entryModel, {
          ownerPaperScenario: true,
          liquidity: async (mint) => ({
            mint,
            usd: '1000000',
            provenance: 'MODEL_combined_liquidity',
            observedAt: Date.now(),
            expiresAt: Date.now() + 60000,
          }),
        });
        const decision = await manager.submitSignal(
          bot.id,
          'momentum',
          { token: MINT, side: 'buy', confidence: 0.8, reason: 'explicit owner fixture signal' },
          `all-three:${firstFence}`,
          {
            mint: MINT,
            priceSol: '1',
            provenance: 'explicit_combined_forecast',
            observedAt: Date.now(),
            expiresAt: Date.now() + 60000,
          },
        );
        expect(decision.status, decision.status === 'vetoed' ? decision.code : undefined).toBe(
          'approved',
        );
        if (decision.status !== 'approved') throw new Error(decision.code);
        const intent = decision.intent,
          entryBroker = createRiskPaperBroker(single, source, entryModel);
        const entry = await entryBroker.execute(intent, `all-three-entry:${firstFence}`);
        expect(entry.status).toBe('partial');
        const principal = BigInt(entry.inputRaw),
          entryFee = BigInt(entry.networkFeeLamports) + BigInt(entry.priorityFeeLamports),
          acquired = BigInt(entry.outputRaw);
        const position = (
          await single.query<{ id: string }>('SELECT id FROM positions WHERE bot_id=$1', [bot.id])
        ).rows[0]!.id;
        const commitment = (
          await single.query('SELECT * FROM risk_position_commitments WHERE position_id=$1', [
            position,
          ])
        ).rows[0]!;
        const consumed = principal + entryFee;
        const before = await riskExposure(single, bot.id);
        expect(before.debit).toBeGreaterThan(0n);
        expect(before.loss).toBeGreaterThan(BigInt(commitment.loss_remaining));
        const assertReleased = async () => {
          expect(
            (
              await single.query(
                'SELECT state,debit_remaining,loss_remaining FROM risk_reservations WHERE admission_id=$1',
                [intent.approval.reference],
              )
            ).rows[0],
          ).toMatchObject({ state: 'terminal', debit_remaining: '0', loss_remaining: '0' });
          expect(await riskExposure(single, bot.id)).toEqual({
            debit: 0n,
            loss: BigInt(commitment.loss_remaining),
            feeCash: BigInt(commitment.fee_cash),
          });
          expect(
            (
              await single.query(
                'SELECT consumed_lamports FROM risk_paper_accounts WHERE bot_id=$1',
                [bot.id],
              )
            ).rows[0]!.consumed_lamports,
          ).toBe(consumed.toString());
          expect(
            (
              await single.query('SELECT * FROM risk_position_commitments WHERE position_id=$1', [
                position,
              ])
            ).rows[0],
          ).toEqual(commitment);
          expect((await getControlledBot(single, bot.id)).paperBankrollLamports).toBe(
            (initialCash - consumed).toString(),
          );
        };
        if (firstFence === 'off') {
          const current = await getControlledBot(single, bot.id);
          const off = await transitionControlledBot(single, bot.id, {
            mode: 'off',
            revision: current.revision,
          });
          await assertReleased();
          await transitionControlledBot(single, bot.id, { mode: 'paper', revision: off.revision });
          // Inspect immediately after resume, before any admission/reconciliation can hide a stale hold.
          await assertReleased();
        }
        let calls = 0;
        const exitSource: PaperQuoteProvider = {
          ...source,
          quote: async (request) => {
            if (++calls === 2) {
              // The entry remainder must already be released by exit's direct status UPDATE, before sell IO.
              await assertReleased();
              expect(
                (
                  await single.query(
                    'SELECT original_raw FROM position_exit_state WHERE position_id=$1',
                    [position],
                  )
                ).rows[0]!.original_raw,
              ).toBe(acquired.toString());
              const current = await getControlledBot(single, bot.id);
              await transitionControlledBot(single, bot.id, {
                mode: 'off',
                revision: current.revision,
              });
            }
            return quote(request);
          },
        };
        const paused = (
          await new PositionExitManager(single, exitSource).once({ botId: bot.id })
        )[0]!;
        expect(paused.result).toMatchObject({
          status: 'cancelled',
          inputRaw: '0',
          outputRaw: '0',
          networkFeeLamports: '0',
          priorityFeeLamports: '0',
        });
        await assertReleased();
        const off = await getControlledBot(single, bot.id);
        await transitionControlledBot(single, bot.id, { mode: 'paper', revision: off.revision });
        await assertReleased();
        await expect(
          entryBroker.execute(intent, `all-three-forbidden-remainder:${firstFence}`),
        ).rejects.toThrow('RISK_ORDER_TERMINAL');
        await assertReleased();
        await single.query(
          "UPDATE position_exit_state SET retry_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE position_id=$1",
          [position],
        );
        const closed = (
          await new PositionExitManager(single, {
            ...source,
            quote: async (request) => quote(request, 1n, 10n),
          }).once({ botId: bot.id })
        )[0]!;
        expect(closed.result?.status).toBe('filled');
        const proceeds = acquired / 10n,
          exitFee = 5000n,
          totalPnl = proceeds - principal - entryFee - exitFee;
        expect((await getControlledBot(single, bot.id)).paperBankrollLamports).toBe(
          (initialCash - consumed + proceeds - exitFee).toString(),
        );
        expect(
          (
            await single.query(
              'SELECT consumed_lamports FROM risk_paper_accounts WHERE bot_id=$1',
              [bot.id],
            )
          ).rows[0]!.consumed_lamports,
        ).toBe((consumed + exitFee).toString());
        expect(await riskExposure(single, bot.id)).toEqual({ debit: 0n, loss: 0n, feeCash: 0n });
        expect(
          (
            await single.query(
              'SELECT status,remaining_raw,close_reason,realized_pnl_lamports FROM positions WHERE id=$1',
              [position],
            )
          ).rows[0],
        ).toMatchObject({
          status: 'closed',
          remaining_raw: '0',
          close_reason: 'stop_loss',
          realized_pnl_lamports: totalPnl.toString(),
        });
        expect(
          (await single.query('SELECT losses FROM risk_streaks WHERE bot_id=$1', [bot.id])).rows[0]!
            .losses,
        ).toBe(1);
        expect(
          (await single.query('SELECT loss_used_lamports FROM risk_days WHERE bot_id=$1', [bot.id]))
            .rows[0]!.loss_used_lamports,
        ).toBe((-totalPnl).toString());
        expect(
          (
            await single.query(
              'SELECT COALESCE(sum(realized_lamports),0)::text pnl,count(*) FILTER(WHERE closed)::integer closed FROM risk_pnl_events WHERE bot_id=$1',
              [bot.id],
            )
          ).rows[0],
        ).toMatchObject({ pnl: totalPnl.toString(), closed: 1 });
        expect(
          (
            await single.query('SELECT count(*)::integer n FROM fills WHERE order_id=$1', [
              intent.orderId,
            ])
          ).rows[0]!.n,
        ).toBe(1);
        expect((await single.query('SELECT count(*)::integer n FROM fills')).rows[0]!.n).toBe(2);
        expect(single.waitingCount).toBe(0);
      } finally {
        await single.end();
        key.fill(0);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

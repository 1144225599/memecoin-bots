import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApprovedOrderIntent,
  OpportunityTarget,
  PaperModel,
  RiskDecision,
  RiskLiquidity,
} from '@memebots/core';
import {
  RiskManager,
  profileSafetyPolicy,
  createRiskPaperBroker,
} from '../../../apps/engine/src/risk/manager.js';
import { PaperBroker } from '../../../apps/engine/src/paper/broker.js';
import { normalizeJupiterQuote } from '../../../apps/engine/src/paper/quote.js';
import type { PaperQuoteProvider, QuoteRequest } from '../../../apps/engine/src/paper/quote.js';
import { fixtureAddress, goodScenario } from '../../../apps/engine/src/safety/fixtures.js';
import { unknownEvidence } from '../../../apps/engine/src/safety/evidence.js';
import { migrateDown, migrateUp, loadMigrations } from './migrate.js';
import { createPool, withTransaction } from './pool.js';
import { SafetyStore } from './safety.js';
import { cancelPaperOrder, registerPaperIntent } from './paper-execution.js';
import {
  ensureRiskDay,
  reconcileRiskAdmissions,
  riskExposure,
  setPaperRiskCap,
} from './risk-admission.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';

const MINT = fixtureAddress(1),
  OTHER = fixtureAddress(55);
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
    selectedBy: 'risk-test',
    networkLamports: '5',
    priorityLamports: '0',
  },
};
function provider(ratio = 10n, sellOutput?: (r: QuoteRequest) => bigint): PaperQuoteProvider {
  return {
    currentContext: async () => undefined,
    quote: async (request) => {
      const input = BigInt(request.inputRaw),
        output =
          request.intent.side === 'buy' ? input * ratio : (sellOutput?.(request) ?? input / 20n);
      const [inputMint, outputMint] =
        request.intent.side === 'buy'
          ? ['So11111111111111111111111111111111111111112', request.intent.tokenMint]
          : [request.intent.tokenMint, 'So11111111111111111111111111111111111111112'];
      const now = Date.now();
      return {
        status: 'available',
        quote: normalizeJupiterQuote(
          {
            router: 'metis',
            transaction: null,
            inputMint,
            outputMint,
            inAmount: input.toString(),
            outAmount: output.toString(),
            otherAmountThreshold: (
              (output * BigInt(10000 - request.intent.maxSlippageBps)) /
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
                swapInfo: {
                  ammKey: MINT,
                  inputMint,
                  outputMint,
                  inAmount: input.toString(),
                  outAmount: output.toString(),
                },
              },
            ],
          },
          request,
          now,
          now,
          true,
        ),
      };
    },
  };
}
const target = (mint = MINT, price = '1'): OpportunityTarget => {
  const now = Date.now();
  return {
    mint,
    priceSol: price,
    provenance: 'explicit_test_forecast',
    observedAt: now,
    expiresAt: now + 60000,
  };
};
const liquidity = (mint = MINT, usd = '1000000'): RiskLiquidity => {
  const now = Date.now();
  return {
    mint,
    usd,
    provenance: 'MODEL_liquidity_fixture',
    observedAt: now,
    expiresAt: now + 60000,
  };
};
const signal = (mint = MINT) => ({
  token: mint,
  side: 'buy',
  confidence: 0.8,
  reason: 'private-free-text-not-for-audit',
});
function approved(d: RiskDecision): ApprovedOrderIntent {
  expect(d.status, d.status === 'vetoed' ? d.code : undefined).toBe('approved');
  if (d.status !== 'approved') throw new Error(d.code);
  return d.intent;
}

describe.skipIf(!hasTestDatabase)('risk admission and real paper pipeline', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  let botId: string;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
    const wallet = (
      await pool.query<{ id: string }>(
        "INSERT INTO wallets(label,public_key,spend_cap_lamports) VALUES('risk public fixture',$1,1000000000000000000000000000000) RETURNING id",
        [fixtureAddress(66)],
      )
    ).rows[0]!;
    botId = (
      await pool.query<{ id: string }>(
        "INSERT INTO bots(name,strategy,risk_profile_id,wallet_id,mode,paper_bankroll_lamports) VALUES('risk-test','momentum','balanced',$1,'paper',1000000000000) RETURNING id",
        [wallet.id],
      )
    ).rows[0]!.id;
    await setPaperRiskCap(pool, botId, '1000000000000000000000000000000');
    await saveSafety(MINT);
    await saveSafety(OTHER);
  });
  afterAll(async () => pool.end());
  async function saveSafety(mint: string, unknown = false) {
    const e = unknown ? unknownEvidence(mint, null, Date.now(), 60000) : goodScenario();
    e.mint = mint;
    e.decimals = 9;
    if (!unknown) {
      e.checks.sell.facts!.mint = mint;
      e.checks.holders.facts!.developerOwner = fixtureAddress(60);
    }
    const store = new SafetyStore(pool),
      key = `solana:${mint}:none`,
      lease = await store.acquire(key);
    if (!lease) throw new Error('lease');
    await store.save({
      key,
      mint,
      evidence: e,
      expiresAt: e.checks.mintAuthority.expiresAt,
      refreshMs: 60000,
      lease,
    });
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9) ON CONFLICT DO NOTHING', [
      mint,
    ]);
  }
  function manager(
    options: {
      ownerPaperScenario?: boolean;
      usd?: string;
      provider?: PaperQuoteProvider;
      model?: PaperModel;
      pool?: typeof pool;
    } = {},
  ) {
    return new RiskManager(
      options.pool ?? pool,
      options.provider ?? provider(),
      options.model ?? model,
      {
        ownerPaperScenario: options.ownerPaperScenario ?? true,
        liquidity: async (mint) => liquidity(mint, options.usd),
      },
    );
  }
  async function admit(key = 'entry', mint = MINT, options: Parameters<typeof manager>[0] = {}) {
    return manager(options).submitSignal(botId, 'momentum', signal(mint), key, target(mint));
  }
  async function sell(
    intent: ApprovedOrderIntent,
    fraction = 1n,
    quoteProvider = provider(),
  ): Promise<void> {
    const pos = (
      await pool.query<{ id: string; remaining_raw: string }>(
        "SELECT * FROM positions WHERE bot_id=$1 AND status='open'",
        [botId],
      )
    ).rows[0]!;
    const id = randomUUID(),
      sale: ApprovedOrderIntent = {
        ...intent,
        orderId: id,
        clientOrderId: `owner-sale:${id}`,
        positionId: pos.id,
        side: 'sell',
        amountInRaw: (BigInt(pos.remaining_raw) / fraction).toString(),
        expiresAt: Date.now() + 5000,
        approval: { kind: 'manual_paper_scenario', reference: 'owner-reduction-fixture' },
        entry: null,
        closeReason: 'manual',
      };
    await pool.query(
      "INSERT INTO orders(id,client_order_id,bot_id,position_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,$5,'sell','paper',$6,$7,'OWNER_REDUCTION_TEST')",
      [
        id,
        sale.clientOrderId,
        botId,
        pos.id,
        sale.tokenMint,
        sale.amountInRaw,
        sale.maxSlippageBps,
      ],
    );
    await registerPaperIntent(pool, sale);
    expect(
      (await new PaperBroker(pool, quoteProvider, model).execute(sale, `sell:${id}`)).status,
    ).toBe('filled');
  }
  it('runs signal → exact admission → actual broker fill and persists isolated budgets', async () => {
    const intent = approved(await admit());
    expect(intent.amountInRaw).toBe('20000000000');
    expect(intent.approval.kind).toBe('risk_manager');
    const result = await new PaperBroker(pool, provider(), model).execute(intent, 'fill');
    expect(result.status).toBe('filled');
    const account = (await pool.query('SELECT * FROM risk_paper_accounts WHERE bot_id=$1', [botId]))
      .rows[0];
    expect(account.consumed_lamports).toBe('20000000005');
    expect((await pool.query('SELECT * FROM wallet_spend_state')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM risk_reservations')).rows[0].state).toBe('terminal');
    expect((await pool.query('SELECT * FROM risk_pnl_events')).rowCount).toBe(1);
    expect(JSON.stringify((await pool.query('SELECT details FROM audit_log')).rows)).not.toContain(
      'private-free-text',
    );
    const fresh = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      expect(
        (await fresh.query('SELECT * FROM risk_paper_accounts WHERE bot_id=$1', [botId])).rows[0]
          .consumed_lamports,
      ).toBe(account.consumed_lamports);
    } finally {
      await fresh.end();
    }
  });
  it('sizes from liquid cash only with exact >2^53 integers', async () => {
    const cash = 900719925474099300000n;
    await pool.query('UPDATE bots SET paper_bankroll_lamports=$2 WHERE id=$1', [
      botId,
      cash.toString(),
    ]);
    expect(approved(await admit()).amountInRaw).toBe(((cash * 2n) / 100n).toString());
  });
  it('caps size at 5% and ignores a weaker suggested stop', async () => {
    await pool.query("UPDATE bots SET risk_profile_id='degen' WHERE id=$1", [botId]);
    const intent = approved(
      await manager().submitSignal(
        botId,
        'momentum',
        { ...signal(), suggestedStopDistance: 0.9 },
        'degen',
        target(),
      ),
    );
    expect(intent.amountInRaw).toBe('50000000000');
    expect(Number(intent.entry!.stopPriceSol)).toBeLessThan(0.06);
  });
  it.each(['conservative', 'balanced', 'aggressive', 'degen'])(
    'evaluates all checks under %s safety policy',
    async (profile) => {
      await pool.query('UPDATE bots SET risk_profile_id=$2 WHERE id=$1', [botId, profile]);
      expect((await admit()).status).toBe('approved');
    },
  );
  it('rejects production scenario evidence and unknown evidence; capability exposes submit only', async () => {
    const risk = manager({ ownerPaperScenario: false });
    expect(Object.keys(risk.forStrategy(botId, 'momentum'))).toEqual(['submitSignal']);
    expect(
      await risk.forStrategy(botId, 'momentum').submitSignal(signal(), 'scenario', target()),
    ).toMatchObject({ status: 'vetoed', code: 'SCENARIO_EVIDENCE_FORBIDDEN' });
    await saveSafety(MINT, true);
    expect(await risk.submitSignal(botId, 'momentum', signal(), 'unknown', target())).toMatchObject(
      { status: 'vetoed', code: 'SAFETY_DENIED' },
    );
    expect(() => manager().forStrategy(botId, 'momentum')).toThrow('OWNER_SCENARIO');
    expect(profileSafetyPolicy({ safetyMode: 'relaxed', minSafetyScore: 1 }).minScore).toBe(1);
  });
  it('records malformed/unknown/sell/no-target vetoes without fabricating tokens or orders', async () => {
    const cases: [string, unknown, OpportunityTarget | undefined, string, string][] = [
      ['malformed', { ...signal(), confidence: NaN }, target(), botId, 'INVALID_SIGNAL'],
      ['target', signal(), undefined, botId, 'TARGET_UNAVAILABLE'],
      ['sell', { ...signal(), side: 'sell' }, target(), botId, 'EXIT_MANAGER_REQUIRED'],
      ['unknown', signal(), target(), randomUUID(), 'BOT_NOT_FOUND'],
      ['badbot', signal(), target(), 'bad', 'INVALID_SIGNAL'],
    ];
    for (const [key, input, opportunity, id, code] of cases)
      expect(await manager().submitSignal(id, 'momentum', input, key, opportunity)).toMatchObject({
        status: 'vetoed',
        code,
      });
    expect((await pool.query("SELECT * FROM risk_decisions WHERE status='vetoed'")).rowCount).toBe(
      cases.length,
    );
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM tokens')).rowCount).toBe(2);
  });
  it('replays matching requests and audits duplicate-key parameter mismatch', async () => {
    const risk = manager(),
      t = target(),
      a = await risk.submitSignal(botId, 'momentum', signal(), 'same', t),
      b = await risk.submitSignal(botId, 'momentum', signal(), 'same', t);
    expect(b).toEqual(a);
    expect(
      await risk.submitSignal(botId, 'momentum', { ...signal(), confidence: 0.9 }, 'same', t),
    ).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(1);
  });
  it.each([
    ["UPDATE bots SET mode='off'", 'BOT_NOT_PAPER'],
    ["UPDATE bots SET strategy='sniper'", 'STRATEGY_ASSIGNMENT_MISMATCH'],
    [
      "UPDATE risk_profiles SET daily_loss_limit_fraction=.00001 WHERE id='balanced'",
      'DAILY_LOSS_LIMIT',
    ],
    ['UPDATE risk_paper_accounts SET cap_lamports=1', 'PAPER_CAP_EXCEEDED'],
    ['DELETE FROM risk_paper_accounts', 'PAPER_CAP_NOT_CONFIGURED'],
    ['INSERT INTO risk_streaks(bot_id,losses) SELECT id,4 FROM bots', 'LOSING_STREAK_LIMIT'],
    ['UPDATE bots SET paper_bankroll_lamports=1', 'INSUFFICIENT_PAPER_CASH'],
  ])('enforces durable entry limit %s', async (sql, code) => {
    await pool.query(sql);
    expect(await admit()).toMatchObject({ status: 'vetoed', code });
  });
  it('enforces independent liquidity, slippage, target freshness and net RR', async () => {
    expect(await admit('liq', MINT, { usd: '1' })).toMatchObject({ code: 'MIN_LIQUIDITY' });
    expect(
      await admit('slip', MINT, { model: { ...model, adverseSlippageBps: 201 } }),
    ).toMatchObject({ code: 'MAX_SLIPPAGE' });
    expect(
      await manager().submitSignal(botId, 'momentum', signal(), 'stale', {
        ...target(),
        observedAt: Date.now() - 60001,
        expiresAt: Date.now() + 1,
      }),
    ).toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    expect(
      await manager().submitSignal(botId, 'momentum', signal(), 'rr', target(MINT, '0.11')),
    ).toMatchObject({ code: 'MIN_REWARD_RISK' });
  });
  it('allows only one concurrent unique entry under max-position limit, including pending entries', async () => {
    await pool.query("UPDATE risk_profiles SET max_open_positions=1 WHERE id='balanced'");
    const results = await Promise.all([admit('a', MINT), admit('b', OTHER)]);
    expect(results.filter((r) => r.status === 'approved')).toHaveLength(1);
    expect(results.find((r) => r.status === 'vetoed')).toMatchObject({
      code: 'MAX_OPEN_POSITIONS',
    });
    const first = results.find((r) => r.status === 'approved')!;
    expect(await admit('dup', approved(first).tokenMint)).toMatchObject({
      code: 'POSITION_ALREADY_OPEN_OR_PENDING',
    });
  });
  it('pending stop risk consumes daily allowance and fees consume cap/cash capacity', async () => {
    await pool.query("UPDATE risk_profiles SET daily_loss_limit_fraction=.005 WHERE id='balanced'");
    approved(await admit());
    expect(await admit('second', OTHER)).toMatchObject({ code: 'DAILY_LOSS_LIMIT' });
    await expect(setPaperRiskCap(pool, botId, '1')).rejects.toThrow('PAPER_CAP_BELOW_COMMITMENT');
  });
  it.each([
    ['0.004320000021', 'approved'],
    ['0.00432000002', 'vetoed'],
  ])('daily integer boundary %s is %s', async (fraction, status) => {
    await pool.query("UPDATE risk_profiles SET daily_loss_limit_fraction=$1 WHERE id='balanced'", [
      fraction,
    ]);
    const decision = await admit('daily-equal');
    expect(decision.status).toBe(status);
    if (decision.status === 'vetoed') {
      expect(decision.code).toBe('DAILY_LOSS_LIMIT');
      expect(
        (await pool.query('SELECT metrics FROM risk_decisions WHERE id=$1', [decision.id])).rows[0]
          .metrics,
      ).toMatchObject({ used: '0', reserved: '0', requested: '4320000021', limit: '4320000020' });
    }
  });
  it('profile edits during quote IO veto and pending authorization cannot execute after edits', async () => {
    const source = provider(),
      mutating: PaperQuoteProvider = {
        ...source,
        quote: async (req) => {
          await pool.query("UPDATE risk_profiles SET max_slippage_bps=199 WHERE id='balanced'");
          return source.quote(req);
        },
      };
    expect(await admit('changing', MINT, { provider: mutating })).toMatchObject({
      code: 'PROFILE_CHANGED',
    });
    const intent = approved(await admit('new'));
    await pool.query("UPDATE risk_profiles SET min_reward_risk=3 WHERE id='balanced'");
    await expect(new PaperBroker(pool, provider(), model).execute(intent, 'stale')).rejects.toThrow(
      'RISK_AUTHORIZATION_STALE',
    );
    await reconcileRiskAdmissions(pool, botId);
    expect((await riskExposure(pool, botId)).debit).toBe(0n);
  });
  it('forged markers/references/modified intents/models cannot execute', async () => {
    const intent = approved(await admit());
    await expect(
      registerPaperIntent(pool, {
        ...intent,
        approval: { kind: 'risk_manager', reference: randomUUID() },
      }),
    ).rejects.toThrow('RISK_RECEIPT_REQUIRED');
    await expect(
      new PaperBroker(pool, provider(), {
        ...model,
        fees: { ...model.fees, networkLamports: '6' },
      }).execute(intent, 'wrongmodel'),
    ).rejects.toThrow('RISK_MODEL_MISMATCH');
    await expect(
      new PaperBroker(pool, provider(), model).execute(
        { ...intent, amountInRaw: '1' },
        'wrongsize',
      ),
    ).rejects.toThrow('PERSISTED_ORDER_MISMATCH');
    const result = await new PaperBroker(pool, provider(5n), model).execute(intent, 'moved');
    expect(result).toMatchObject({ status: 'failed', reason: 'RISK_QUOTE_MOVED', inputRaw: '0' });
    expect(
      (
        await pool.query<{ code: string }>(
          "SELECT code FROM risk_decisions WHERE status='vetoed' ORDER BY created_at",
        )
      ).rows.map((r) => r.code),
    ).toEqual(['RISK_RECEIPT_REQUIRED', 'RISK_MODEL_MISMATCH', 'RISK_QUOTE_MOVED']);
  });
  it('submitted failure fees count once and release remaining reservations across replay', async () => {
    const failing = { ...model, failureProbability: 1 };
    const intent = approved(await admit('f', MINT, { model: failing }));
    const broker = new PaperBroker(pool, provider(), failing);
    const result = await broker.execute(intent, 'failure');
    expect(result.status).toBe('failed');
    expect(await broker.execute(intent, 'failure')).toEqual(result);
    expect((await pool.query('SELECT * FROM risk_days')).rows[0].loss_used_lamports).toBe('5');
    expect((await riskExposure(pool, botId)).debit).toBe(0n);
    expect((await pool.query('SELECT * FROM risk_streaks')).rowCount).toBe(0);
  });
  it('partial entry restart retains reservation, cancels remainder and allocates sell loss/streak only on close', async () => {
    const partial = { ...model, partialFillBps: 5000 };
    const intent = approved(await admit('partial', MINT, { model: partial }));
    expect(
      (await new PaperBroker(pool, provider(), partial).execute(intent, 'partial1')).status,
    ).toBe('partial');
    expect((await riskExposure(pool, botId)).debit).toBeGreaterThan(0n);
    await cancelPaperOrder(pool, intent.orderId);
    expect((await riskExposure(pool, botId)).debit).toBe(0n);
    await sell(intent, 2n);
    expect((await pool.query('SELECT * FROM risk_streaks')).rowCount).toBe(0);
    await sell(intent);
    expect((await pool.query('SELECT * FROM risk_streaks')).rows[0].losses).toBe(1);
    expect(
      BigInt((await pool.query('SELECT * FROM risk_days')).rows[0].loss_used_lamports),
    ).toBeGreaterThan(0n);
    expect((await riskExposure(pool, botId)).loss).toBe(0n);
  });
  it('entry loss/streak/safety vetoes do not prevent owner-authorized reductions', async () => {
    const intent = approved(await admit());
    await new PaperBroker(pool, provider(), model).execute(intent, 'buy');
    await pool.query('INSERT INTO risk_streaks(bot_id,losses) VALUES($1,100)', [botId]);
    await saveSafety(MINT, true);
    await sell(intent);
    expect((await pool.query("SELECT * FROM positions WHERE status='open'")).rowCount).toBe(0);
  });
  it('UTC day opening book is immutable; top-ups cannot dilute limit and gains do not replenish losses', async () => {
    await withTransaction(pool, async (db) => {
      await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId]);
      await ensureRiskDay(db, botId);
    });
    const before = (await pool.query('SELECT * FROM risk_days')).rows[0];
    await pool.query(
      'UPDATE bots SET paper_bankroll_lamports=paper_bankroll_lamports*10 WHERE id=$1',
      [botId],
    );
    await withTransaction(pool, (db) => ensureRiskDay(db, botId));
    expect((await pool.query('SELECT * FROM risk_days')).rows[0].limit_lamports).toBe(
      before.limit_lamports,
    );
    await expect(pool.query('UPDATE risk_days SET opening_book_lamports=1')).rejects.toThrow(
      'immutable',
    );
  });
  it('max=1 pool completes admission and actual broker fill without nested transactions', async () => {
    const small = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      const intent = approved(await admit('single', MINT, { pool: small }));
      expect(
        (await new PaperBroker(small, provider(), model).execute(intent, 'single-fill')).status,
      ).toBe('filled');
      expect(small.waitingCount).toBe(0);
    } finally {
      await small.end();
    }
  });
  it('veto audit failure rolls decision back and immutable rows reject edits', async () => {
    const intent = approved(await admit());
    await expect(
      pool.query('UPDATE risk_admissions SET intent=$1 WHERE order_id=$2', [
        JSON.stringify({ ...intent, amountInRaw: '1' }),
        intent.orderId,
      ]),
    ).rejects.toThrow('append-only');
    await pool.query(
      `CREATE FUNCTION fail_risk_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='risk.vetoed' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_risk_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_risk_audit()`,
    );
    await expect(manager().submitSignal(botId, 'momentum', null, 'audit-fail')).rejects.toThrow(
      'RISK_STORAGE_UNAVAILABLE',
    );
    expect(
      (await pool.query("SELECT * FROM risk_decisions WHERE request_key='audit-fail'")).rowCount,
    ).toBe(0);
  });
  it('risk migration round-trips empty accounting, and refuses destructive rollback with active admission', async () => {
    const riskAndLater = (await loadMigrations()).filter((m) => m.version >= '0013').length;
    await migrateDown(pool, riskAndLater);
    await migrateUp(pool);
    await setPaperRiskCap(pool, botId, '1000000000000000000000000000000');
    approved(await admit());
    await expect(migrateDown(pool, riskAndLater)).rejects.toThrow('risk accounting in use');
  });
  it('actual risk pipeline reuses the admitted quote without a second rate-budget request', async () => {
    const source = provider();
    let calls = 0;
    const limited: PaperQuoteProvider = {
      currentContext: () => source.currentContext(),
      quote: async (req) => {
        if (++calls > 1) throw new Error('RATE_BUDGET');
        return source.quote(req);
      },
    };
    const intent = approved(await admit('reuse', MINT, { provider: limited }));
    expect(
      (await createRiskPaperBroker(pool, limited, model).execute(intent, 'reuse-fill')).status,
    ).toBe('filled');
    expect(calls).toBe(1);
  });
  it('concrete CLI persists an explicit production veto without calling a quote network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'risk-cli-'));
    try {
      const path = join(dir, 'signal.json');
      await writeFile(
        path,
        JSON.stringify({
          botId,
          strategy: 'momentum',
          key: 'cli',
          signal: signal(),
          target: target(),
          liquidity: liquidity(),
          model,
        }),
      );
      const result = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--conditions=@memebots/source',
          resolve('apps/engine/src/risk/cli.ts'),
          'submit',
          path,
        ],
        { cwd: resolve('.'), env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        evidenceMode: 'PRODUCTION',
        decision: { status: 'vetoed', code: 'SCENARIO_EVIDENCE_FORBIDDEN' },
      });
      expect(
        (await pool.query("SELECT * FROM risk_decisions WHERE request_key='cli'")).rowCount,
      ).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('transfers fee reserves across three partial attempts without exceeding an exact cumulative cap', async () => {
    await setPaperRiskCap(pool, botId, '20000000020');
    const partial = { ...model, partialFillBps: 5000 },
      intent = approved(await admit('bounded', MINT, { model: partial }));
    const broker = new PaperBroker(pool, provider(), partial);
    for (let n = 1; n <= 3; n++)
      expect((await broker.execute(intent, `bounded:${n}`)).status).toBe('partial');
    expect(
      (await pool.query('SELECT status FROM orders WHERE id=$1', [intent.orderId])).rows[0].status,
    ).toBe('cancelled');
    expect((await riskExposure(pool, botId)).debit).toBe(0n);
    const account = (await pool.query('SELECT * FROM risk_paper_accounts WHERE bot_id=$1', [botId]))
      .rows[0];
    expect(
      BigInt(account.consumed_lamports) + (await riskExposure(pool, botId)).feeCash,
    ).toBeLessThanOrEqual(20000000020n);
  });
  it('unavailable quotes exhaust bounded attempts and release pending holds without fees', async () => {
    const intent = approved(await admit()),
      unavailable: PaperQuoteProvider = {
        quote: async () => ({ status: 'unavailable', reason: 'TEST_NO_QUOTE' }),
        currentContext: async () => undefined,
      };
    const broker = new PaperBroker(pool, unavailable, model);
    for (let n = 1; n <= 3; n++)
      expect((await broker.execute(intent, `none:${n}`)).status).toBe('unavailable');
    expect(
      (await pool.query('SELECT status FROM orders WHERE id=$1', [intent.orderId])).rows[0].status,
    ).toBe('cancelled');
    expect((await riskExposure(pool, botId)).debit).toBe(0n);
    expect(
      (await pool.query('SELECT consumed_lamports FROM risk_paper_accounts')).rows[0]
        .consumed_lamports,
    ).toBe('0');
  });
  it('cancellation SQL releases pending reservations atomically without importing a risk helper', async () => {
    const intent = approved(await admit());
    await withTransaction(pool, async (db) => {
      await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId]);
      await db.query("UPDATE orders SET status='cancelled' WHERE id=$1", [intent.orderId]);
      expect((await riskExposure(db, botId)).debit).toBe(0n);
    });
  });
  it('wins reset streak but never replenish daily losses; break-even does not reset streak', async () => {
    let intent = approved(await admit('loser'));
    await new PaperBroker(pool, provider(), model).execute(intent, 'loser-fill');
    await sell(intent);
    expect((await pool.query('SELECT losses FROM risk_streaks')).rows[0].losses).toBe(1);
    const used = (await pool.query('SELECT loss_used_lamports FROM risk_days')).rows[0]
      .loss_used_lamports;
    intent = approved(await admit('winner'));
    await new PaperBroker(pool, provider(), model).execute(intent, 'winner-fill');
    await sell(
      intent,
      1n,
      provider(10n, (r) => BigInt(r.inputRaw) / 5n),
    );
    expect((await pool.query('SELECT losses FROM risk_streaks')).rows[0].losses).toBe(0);
    expect(
      (await pool.query('SELECT loss_used_lamports FROM risk_days')).rows[0].loss_used_lamports,
    ).toBe(used);
    intent = approved(await admit('even'));
    await new PaperBroker(pool, provider(), model).execute(intent, 'even-fill');
    await pool.query('UPDATE risk_streaks SET losses=1');
    const basis = BigInt(
      (await pool.query("SELECT cost_lamports FROM positions WHERE status='open'")).rows[0]
        .cost_lamports,
    );
    await sell(
      intent,
      1n,
      provider(10n, () => basis + 5n),
    );
    expect((await pool.query('SELECT losses FROM risk_streaks')).rows[0].losses).toBe(1);
  });
  it('UTC rollover resets realized-day usage while retaining prior open stop-risk commitments', async () => {
    await pool.query(
      "INSERT INTO risk_days(bot_id,day,opening_book_lamports,limit_lamports,loss_used_lamports) VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date-1,100,10,10)",
      [botId],
    );
    const pos = (
      await pool.query<{ id: string }>(
        "INSERT INTO positions(bot_id,token_mint,mode,entry_price_sol,quantity_raw,remaining_raw,cost_lamports,stop_price_sol,high_water_price_sol) VALUES($1,$2,'paper',.1,100,100,1000000000,.08,.1) RETURNING id",
        [botId, MINT],
      )
    ).rows[0]!;
    await pool.query(
      'INSERT INTO risk_position_commitments(position_id,bot_id,loss_remaining,fee_cash,max_slippage_bps,adverse_bps) VALUES($1,$2,100000000000,5,200,0)',
      [pos.id, botId],
    );
    expect(await admit('next-day', OTHER)).toMatchObject({ code: 'DAILY_LOSS_LIMIT' });
    expect(
      (
        await pool.query(
          "SELECT loss_used_lamports FROM risk_days WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date",
        )
      ).rows[0].loss_used_lamports,
    ).toBe('0');
  });
  it('expires old/future target and safety assumptions and fails closed when liquidity/quotes are unknown', async () => {
    const noLiquidity = new RiskManager(pool, provider(), model, { ownerPaperScenario: true });
    expect(
      await noLiquidity.submitSignal(botId, 'momentum', signal(), 'no-liq', target()),
    ).toMatchObject({ code: 'LIQUIDITY_UNAVAILABLE' });
    const unavailable: PaperQuoteProvider = {
      quote: async () => ({ status: 'unavailable', reason: 'TEST_UNKNOWN' }),
      currentContext: async () => undefined,
    };
    expect(await admit('no-quote', MINT, { provider: unavailable })).toMatchObject({
      code: 'QUOTE_UNAVAILABLE',
    });
    expect(
      await manager().submitSignal(botId, 'momentum', signal(), 'future', {
        ...target(),
        observedAt: Date.now() + 1000,
      }),
    ).toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    const e = goodScenario(Date.now() - 31000);
    e.checks.holders.facts!.developerOwner = fixtureAddress(60);
    const store = new SafetyStore(pool),
      key = `solana:${MINT}:none`,
      lease = await store.acquire(key);
    await store.save({
      key,
      mint: MINT,
      evidence: e,
      expiresAt: e.checks.mintAuthority.expiresAt,
      refreshMs: 10000,
      lease: lease!,
    });
    expect(await admit('old-safety')).toMatchObject({ code: 'SAFETY_DENIED' });
  });
  it('retains whole remaining retry fees when another admission interleaves partial fills', async () => {
    await pool.query('UPDATE bots SET paper_bankroll_lamports=100000 WHERE id=$1', [botId]);
    await pool.query(
      "UPDATE risk_profiles SET max_slippage_bps=1,daily_loss_limit_fraction=.0144 WHERE id='balanced'",
    );
    const partial = {
      ...model,
      partialFillBps: 9000,
      fees: { ...model.fees, networkLamports: '100' },
    };
    const intent = approved(await admit('conserve', MINT, { model: partial })),
      broker = new PaperBroker(pool, provider(), partial);
    expect((await broker.execute(intent, 'conserve:1')).status).toBe('partial');
    const first = (await riskExposure(pool, botId)).loss;
    expect(
      BigInt(
        (
          await pool.query('SELECT loss_remaining FROM risk_reservations WHERE admission_id=$1', [
            intent.approval.reference,
          ])
        ).rows[0].loss_remaining,
      ),
    ).toBeGreaterThanOrEqual(200n);
    expect(await admit('interleaved', OTHER, { model: partial })).toMatchObject({
      status: 'vetoed',
      code: 'DAILY_LOSS_LIMIT',
    });
    for (let n = 2; n <= 3; n++) {
      expect((await broker.execute(intent, `conserve:${n}`)).status).toBe('partial');
      expect((await riskExposure(pool, botId)).loss).toBeLessThanOrEqual(first);
      expect((await riskExposure(pool, botId)).loss).toBeLessThanOrEqual(1440n);
    }
  });
  it('rejects a full-size RR pass whose tiny partial outcome cannot cover absolute fees', async () => {
    await pool.query('UPDATE bots SET paper_bankroll_lamports=100000 WHERE id=$1', [botId]);
    await pool.query("UPDATE risk_profiles SET max_slippage_bps=1 WHERE id='balanced'");
    const tiny = { ...model, partialFillBps: 100, fees: { ...model.fees, networkLamports: '100' } };
    expect(
      await manager({ model: tiny }).submitSignal(
        botId,
        'momentum',
        signal(),
        'tiny',
        target(MINT, '0.21'),
      ),
    ).toMatchObject({ status: 'vetoed', code: 'PARTIAL_MODEL_NET_REWARD_RISK' });
    expect((await pool.query('SELECT * FROM orders')).rowCount).toBe(0);
    expect(
      (await pool.query('SELECT paper_bankroll_lamports FROM bots WHERE id=$1', [botId])).rows[0]
        .paper_bankroll_lamports,
    ).toBe('100000');
  });
  it.each(['before_prepare', 'during_quote'])(
    'a pending buy rechecks the durable closed-loss streak %s',
    async (stage) => {
      await pool.query('INSERT INTO risk_streaks(bot_id,losses) VALUES($1,3)', [botId]);
      const first = approved(await admit('first')),
        pending = approved(await admit('pending', OTHER));
      await new PaperBroker(pool, provider(), model).execute(first, 'first-fill');
      if (stage === 'before_prepare') {
        await sell(first);
        expect((await pool.query('SELECT losses FROM risk_streaks')).rows[0].losses).toBe(4);
        await expect(
          new PaperBroker(pool, provider(), model).execute(pending, 'blocked-before'),
        ).rejects.toThrow('LOSING_STREAK_LIMIT');
      } else {
        const source = provider(),
          closing: PaperQuoteProvider = {
            currentContext: () => source.currentContext(),
            quote: async (req) => {
              await sell(first);
              return source.quote(req);
            },
          };
        expect(
          await new PaperBroker(pool, closing, model).execute(pending, 'blocked-after'),
        ).toMatchObject({
          status: 'failed',
          reason: 'LOSING_STREAK_LIMIT',
          networkFeeLamports: '0',
          inputRaw: '0',
        });
      }
      expect(
        (await pool.query('SELECT * FROM fills WHERE order_id=$1', [pending.orderId])).rowCount,
      ).toBe(0);
      expect(
        (await pool.query("SELECT * FROM risk_decisions WHERE code='LOSING_STREAK_LIMIT'"))
          .rowCount,
      ).toBe(1);
    },
  );
  it.each(['slippage', 'monotonic', 'unavailable', 'cash_budget'])(
    'persists exactly one final per-attempt risk veto for generic broker %s outcomes',
    async (kind) => {
      const selected = { ...model, adverseSlippageBps: kind === 'slippage' ? 200 : 0 },
        intent = approved(await admit(`veto:${kind}`, MINT, { model: selected }));
      const source = provider(),
        quotes: PaperQuoteProvider = {
          currentContext: () => source.currentContext(),
          quote: async (req) => {
            if (kind === 'unavailable') return { status: 'unavailable', reason: 'TEST_NO_QUOTE' };
            if (kind === 'cash_budget')
              await pool.query('UPDATE bots SET paper_bankroll_lamports=0 WHERE id=$1', [botId]);
            const evidence = await source.quote(req);
            if (kind === 'slippage' && evidence.status === 'available')
              return {
                status: 'available',
                quote: {
                  ...evidence.quote,
                  minimumOutputRaw: evidence.quote.outputRaw,
                  providerMinimumOutputRaw: evidence.quote.outputRaw,
                },
              };
            return evidence;
          },
        };
      let samples = 0;
      const broker = new PaperBroker(
        pool,
        quotes,
        selected,
        kind === 'monotonic' ? { monotonicClock: () => (++samples === 1 ? 0 : 6000) } : {},
      );
      const result = await broker.execute(intent, `execution:${kind}`);
      expect(result.inputRaw).toBe('0');
      expect(result.reason).toBe(
        {
          slippage: 'SLIPPAGE_LIMIT',
          monotonic: 'MONOTONIC_DEADLINE_EXPIRED',
          unavailable: 'TEST_NO_QUOTE',
          cash_budget: 'INSUFFICIENT_PAPER_CASH',
        }[kind],
      );
      expect(await broker.execute(intent, `execution:${kind}`)).toEqual(result);
      const row = (
        await pool.query('SELECT * FROM risk_decisions WHERE execution_attempt_id=$1', [
          result.attemptId,
        ])
      ).rows;
      expect(row).toHaveLength(1);
      expect(row[0].code).toBe(result.reason);
      expect(
        (
          await pool.query(
            "SELECT * FROM audit_log WHERE action='risk.vetoed' AND details->>'attemptId'=$1",
            [result.attemptId],
          )
        ).rowCount,
      ).toBe(1);
    },
  );
  it('partial entry then direct off/cancel and paper resume releases only pending remainder', async () => {
    const partial = { ...model, partialFillBps: 5000 },
      intent = approved(await admit('off-flow', MINT, { model: partial }));
    expect(
      (await new PaperBroker(pool, provider(), partial).execute(intent, 'off-partial')).status,
    ).toBe('partial');
    const consumed = (
      await pool.query('SELECT consumed_lamports FROM risk_paper_accounts WHERE bot_id=$1', [botId])
    ).rows[0].consumed_lamports;
    const positionBefore = (
      await pool.query('SELECT * FROM risk_position_commitments WHERE bot_id=$1', [botId])
    ).rows[0];
    await withTransaction(pool, async (db) => {
      await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId]);
      await db.query('SELECT id FROM orders WHERE bot_id=$1 ORDER BY id FOR UPDATE', [botId]);
      await db.query("UPDATE bots SET mode='off' WHERE id=$1", [botId]);
      await db.query("UPDATE orders SET status='cancelled',failure_reason='BOT_OFF' WHERE id=$1", [
        intent.orderId,
      ]);
      expect((await riskExposure(db, botId)).debit).toBe(0n);
      await db.query("UPDATE bots SET mode='paper' WHERE id=$1", [botId]);
    });
    await reconcileRiskAdmissions(pool, botId);
    expect((await riskExposure(pool, botId)).debit).toBe(0n);
    expect(
      (
        await pool.query('SELECT consumed_lamports FROM risk_paper_accounts WHERE bot_id=$1', [
          botId,
        ])
      ).rows[0].consumed_lamports,
    ).toBe(consumed);
    expect(
      (await pool.query('SELECT * FROM risk_position_commitments WHERE bot_id=$1', [botId]))
        .rows[0],
    ).toEqual(positionBefore);
    await expect(
      new PaperBroker(pool, provider(), partial).execute(intent, 'off-new-attempt'),
    ).rejects.toThrow('RISK_ORDER_TERMINAL');
    expect(
      (await pool.query('SELECT * FROM fills WHERE order_id=$1', [intent.orderId])).rowCount,
    ).toBe(1);
  });
});

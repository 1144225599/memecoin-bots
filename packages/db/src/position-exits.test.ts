import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovedOrderIntent, PaperModel } from '@memebots/core';
import { PaperBroker } from '../../../apps/engine/src/paper/broker.js';
import { normalizeJupiterQuote } from '../../../apps/engine/src/paper/quote.js';
import type { PaperQuoteProvider, QuoteRequest } from '../../../apps/engine/src/paper/quote.js';
import { PositionExitManager } from '../../../apps/engine/src/exits/manager.js';
import { migrateUp, migrateDown, migrationStatus, loadMigrations } from './migrate.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';
import { createPool } from './pool.js';
import {
  claimExitPosition,
  decidePositionExit,
  decimalRatio,
  exitAttemptKey,
  releaseExitLease,
  exitAuthorityValid,
} from './position-exits.js';
import type { ExitPosition, ExitObservation } from './position-exits.js';
import { registerPaperIntent } from './paper-execution.js';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const MODEL: PaperModel = {
  version: 'paper-v1',
  minLatencyMs: 0,
  maxLatencyMs: 0,
  adverseSlippageBps: 0,
  failureProbability: 0,
  failureStage: 'submitted',
  partialFillBps: 10000,
  fees: {
    provenance: 'MODEL',
    selectedBy: 'exit-test',
    networkLamports: '0',
    priorityLamports: '0',
  },
};
function quoteJson(request: QuoteRequest, price = '2') {
  const [n, d] = decimalRatio(price);
  const output = (BigInt(request.inputRaw) * n) / d;
  const inputMint = request.intent.side === 'buy' ? SOL : MINT;
  const outputMint = request.intent.side === 'buy' ? MINT : SOL;
  return {
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
}
function provider(price = '2', unavailable = false): PaperQuoteProvider {
  return {
    currentContext: async () => undefined,
    quote: async (request: QuoteRequest) => {
      if (unavailable) return { status: 'unavailable', reason: 'TEST_UNAVAILABLE' };
      const json = quoteJson(request, price);
      const now = Date.now();
      return { status: 'available', quote: normalizeJupiterQuote(json, request, now, now, true) };
    },
  };
}
describe.skipIf(!hasTestDatabase)('durable position exits', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
  });
  afterAll(async () => pool.end());
  async function seed(
    options: {
      quantity?: string;
      stop?: string;
      trailing?: string | null;
      ageMinutes?: number;
      ladder?: unknown;
      bankroll?: string;
    } = {},
  ) {
    await pool.query(
      "UPDATE risk_profiles SET trailing_stop_fraction=$1,max_hold_minutes=60 WHERE id='balanced'",
      [options.trailing === undefined ? '0.2' : options.trailing],
    );
    const w = (
      await pool.query<{ id: string }>(
        "INSERT INTO wallets(label,public_key) VALUES('exit test',$1) RETURNING id",
        [`P${randomUUID().replaceAll('-', '').replaceAll('0', 'G')}`],
      )
    ).rows[0]!.id;
    const bot = (
      await pool.query<{ id: string }>(
        "INSERT INTO bots(name,strategy,risk_profile_id,wallet_id,mode,paper_bankroll_lamports) VALUES($3,'test','balanced',$1,'paper',$2) RETURNING id",
        [w, options.bankroll ?? '1000000000000000000000000', randomUUID()],
      )
    ).rows[0]!.id;
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9) ON CONFLICT DO NOTHING', [
      MINT,
    ]);
    const qty = options.quantity ?? '1000000000';
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO positions(bot_id,token_mint,mode,entry_price_sol,quantity_raw,remaining_raw,cost_lamports,stop_price_sol,high_water_price_sol,take_profit_remaining,opened_at) VALUES($1,$2,'paper',1,$3,$3,$3,$4,1,$5,clock_timestamp()-$6::integer*interval '1 minute') RETURNING id`,
        [
          bot,
          MINT,
          qty,
          options.stop ?? '0.8',
          JSON.stringify(
            options.ladder ?? [
              { atGain: 0.3, sellFraction: 0.4 },
              { atGain: 0.6, sellFraction: 0.3 },
            ],
          ),
          options.ageMinutes ?? 0,
        ],
      )
    ).rows[0]!.id;
    return { id, bot };
  }
  async function ready(id: string, db = pool) {
    await db.query(
      "UPDATE position_exit_state SET lease_until=NULL,retry_at=clock_timestamp()-interval '1 second' WHERE position_id=$1",
      [id],
    );
  }
  function observation(price: string, offset = 0, p?: ExitPosition): ExitObservation {
    const [n, d] = decimalRatio(price);
    const now = Date.now() + offset;
    return {
      positionId: p?.id ?? '',
      tokenMint: MINT,
      inputRaw: p?.remaining_raw ?? '0',
      numerator: n.toString(),
      denominator: d.toString(),
      observedAt: now,
      expiresAt: now + 5000,
      provenance: { freshnessBasis: 'bounded_request_age_MODEL' },
    };
  }
  async function decision(id: string, price?: string, db = pool) {
    await ready(id, db);
    const owner = randomUUID();
    const p = await claimExitPosition(db, id, owner);
    expect(p).toBeDefined();
    const intent = await decidePositionExit(
      db,
      p!,
      owner,
      price === undefined ? undefined : observation(price, 0, p!),
    );
    return { p: p!, owner, intent };
  }
  async function execute(
    d: { p: ExitPosition; owner: string; intent: ApprovedOrderIntent | undefined },
    model = MODEL,
    source = provider(),
    db = pool,
  ) {
    expect(d.intent).toBeDefined();
    const r = await new PaperBroker(db, source, model).execute(
      d.intent!,
      await exitAttemptKey(db, d.intent!.orderId),
    );
    await releaseExitLease(db, d.p, d.owner, r);
    return r;
  }
  async function state(id: string) {
    return (
      await pool.query(
        'SELECT p.remaining_raw,p.status,p.close_reason,s.* FROM positions p LEFT JOIN position_exit_state s ON s.position_id=p.id WHERE p.id=$1',
        [id],
      )
    ).rows[0]!;
  }
  it.each([
    ['0.8', 'stop_loss'],
    ['1.3', 'take_profit'],
  ])('fires equal threshold %s as %s', async (price, reason) => {
    const { id } = await seed();
    const d = await decision(id, price);
    expect(d.intent?.closeReason).toBe(reason);
    await execute(d);
    expect((await state(id)).remaining_raw).toBe(reason === 'stop_loss' ? '0' : '600000000');
  });
  it('time stop works without price and outranks TP; stop outranks time', async () => {
    const p = await seed({ ageMinutes: 61 });
    const d = await decision(p.id);
    expect(d.intent?.closeReason).toBe('time_stop');
    const q = await seed({ ageMinutes: 61 });
    expect((await decision(q.id, '0.8')).intent?.closeReason).toBe('stop_loss');
    const r = await seed({ ageMinutes: 61 });
    expect((await decision(r.id, '2')).intent?.closeReason).toBe('time_stop');
  });
  it('trailing uses fresh managed high-water and cannot roll backward', async () => {
    const { id } = await seed({ ladder: [{ atGain: 5, sellFraction: 0.5 }] });
    let d = await decision(id, '2');
    expect(d.intent).toBeUndefined();
    await releaseExitLease(pool, d.p, d.owner);
    d = await decision(id, '1.8');
    expect(d.intent).toBeUndefined();
    await releaseExitLease(pool, d.p, d.owner);
    d = await decision(id, '1.6');
    expect(d.intent?.closeReason).toBe('trailing_stop');
    expect((await state(id)).high_n).toBe('2');
  });
  it('rejects delayed observations and never manufactures high-water from unavailable data', async () => {
    const { id } = await seed();
    const d = await decision(id);
    expect(d.intent).toBeUndefined();
    expect((await state(id)).high_n).toBe('0');
    await ready(id);
    const owner = randomUUID();
    const p = (await claimExitPosition(pool, id, owner))!;
    await pool.query('UPDATE position_exit_state SET observed_at_ms=$2 WHERE position_id=$1', [
      id,
      Date.now(),
    ]);
    expect(await decidePositionExit(pool, p, owner, observation('0.1', -10000, p))).toBeUndefined();
    expect((await state(id)).high_n).toBe('0');
  });
  it('gap sells sum of crossed allocations of ORIGINAL and next TP is not a fraction of remaining', async () => {
    const { id } = await seed();
    let d = await decision(id, '1.3');
    expect(d.intent?.amountInRaw).toBe('400000000');
    await execute(d);
    d = await decision(id, '1.6');
    expect(d.intent?.amountInRaw).toBe('300000000');
    await execute(d);
    expect((await state(id)).filled_steps).toEqual(['400000000', '300000000']);
    expect((await state(id)).remaining_raw).toBe('300000000');
    expect(
      (await pool.query('SELECT take_profit_remaining FROM positions WHERE id=$1', [id])).rows[0]!
        .take_profit_remaining,
    ).toEqual([]);
    const gap = await seed();
    const g = await decision(gap.id, '2');
    expect(g.intent?.amountInRaw).toBe('700000000');
    await execute(g);
    expect((await state(gap.id)).filled_steps).toEqual(['400000000', '300000000']);
  });
  it('partial fill/restart allocates exact sold units once, then completes same durable order', async () => {
    const { id } = await seed();
    let d = await decision(id, '2');
    expect((await execute(d, { ...MODEL, partialFillBps: 5000 })).status).toBe('partial');
    expect((await state(id)).filled_steps).toEqual(['350000000', '0']);
    d = await decision(id);
    expect(d.intent?.amountInRaw).toBe('700000000');
    await execute(d);
    expect((await state(id)).filled_steps).toEqual(['400000000', '300000000']);
    await releaseExitLease(pool, d.p, d.owner);
    expect((await state(id)).filled_steps).toEqual(['400000000', '300000000']);
  });
  it('protective exit supersedes pending TP without double sell', async () => {
    const { id } = await seed();
    const first = await decision(id, '1.3');
    await execute(first, { ...MODEL, partialFillBps: 5000 });
    const next = await decision(id, '0.7');
    expect(next.intent?.closeReason).toBe('stop_loss');
    expect(next.intent?.amountInRaw).toBe('800000000');
    expect(await exitAuthorityValid(pool, first.intent!)).toBe(false);
    await execute(next);
    expect((await state(id)).status).toBe('closed');
  });
  it('unavailable and failed attempts retain allocations and requeue remaining without fabricated progress', async () => {
    const { id } = await seed();
    let d = await decision(id, '2');
    await execute(d, MODEL, provider('2', true));
    expect((await state(id)).filled_steps).toEqual([]);
    d = await decision(id);
    await execute(d, { ...MODEL, failureProbability: 1 });
    expect((await state(id)).filled_steps).toEqual([]);
    d = await decision(id);
    expect(d.intent?.amountInRaw).toBe('700000000');
    await execute(d);
    expect((await state(id)).remaining_raw).toBe('300000000');
  });
  it('time stop retries unavailable execution and later closes with actual broker fill', async () => {
    const { id } = await seed({ ageMinutes: 61 });
    let d = await decision(id);
    await execute(d, MODEL, provider('2', true));
    expect((await state(id)).status).toBe('open');
    d = await decision(id);
    await execute(d);
    expect((await state(id)).close_reason).toBe('time_stop');
  });
  it('exact quantities above 2^53 round TP down using integer ratios', async () => {
    const quantity = '900719925474099312345';
    const { id } = await seed({ quantity });
    const d = await decision(id, '1.3');
    expect(d.intent?.amountInRaw).toBe(((BigInt(quantity) * 4n) / 10n).toString());
    await execute(d);
    expect((await state(id)).original_raw).toBe(quantity);
  });
  it('zero dust allocations produce no order', async () => {
    const { id } = await seed({ quantity: '1' });
    expect((await decision(id, '2')).intent).toBeUndefined();
    expect((await pool.query('SELECT * FROM position_exit_decisions')).rows).toHaveLength(0);
  });
  it('snapshot survives profile edits; exact identity cannot authorize a different position', async () => {
    const { id } = await seed();
    await pool.query(
      "UPDATE risk_profiles SET trailing_stop_fraction=0.1,max_hold_minutes=1 WHERE id='balanced'",
    );
    const d = await decision(id, '0.8');
    expect(Number(d.p.policy.trailingFraction)).toBe(0.2);
    expect(d.p.policy.maxHoldMinutes).toBe(60);
    expect(await exitAuthorityValid(pool, { ...d.intent!, positionId: randomUUID() })).toBe(false);
    expect(await exitAuthorityValid(pool, { ...d.intent!, amountInRaw: '1' })).toBe(false);
    expect(
      await exitAuthorityValid(pool, {
        ...d.intent!,
        approval: { kind: 'exit_manager', reference: randomUUID() },
      }),
    ).toBe(false);
  });
  it('forged receipt fails registration and broker preparation', async () => {
    const { id } = await seed();
    const d = await decision(id, '0.8');
    const forged = {
      ...d.intent!,
      approval: { kind: 'exit_manager' as const, reference: randomUUID() },
    };
    await expect(registerPaperIntent(pool, forged)).rejects.toThrow('APPROVAL_AUTHORITY_REQUIRED');
    await expect(
      new PaperBroker(pool, provider(), MODEL).execute(forged, 'forged'),
    ).rejects.toThrow();
  });
  it('competing workers lease one position, one active durable decision; stale generation is fenced', async () => {
    const { id } = await seed();
    const a = randomUUID(),
      b = randomUUID();
    const [pa, pb] = await Promise.all([
      claimExitPosition(pool, id, a),
      claimExitPosition(pool, id, b),
    ]);
    expect([pa, pb].filter(Boolean)).toHaveLength(1);
    const winner = pa ?? pb!;
    const owner = pa ? a : b;
    await ready(id);
    const later = (await claimExitPosition(pool, id, b))!;
    expect(
      await decidePositionExit(pool, winner, owner, observation('0.8', 0, winner)),
    ).toBeUndefined();
    const d = await decidePositionExit(pool, later, b, observation('0.8', 0, later));
    expect(d).toBeDefined();
    expect((await pool.query('SELECT * FROM position_exit_decisions')).rows).toHaveLength(1);
  });
  it('max=1 pool runs real position -> quote -> immutable intent -> broker -> fill -> progress', async () => {
    const { id } = await seed();
    const small = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      const m = new PositionExitManager(small, provider('2'), { model: MODEL });
      const outcomes = await m.once();
      expect(outcomes[0]?.result?.status).toBe('filled');
      expect((await state(id)).filled_steps).toEqual(['400000000', '300000000']);
      expect(small.waitingCount).toBe(0);
    } finally {
      await small.end();
    }
  });
  it('off during quote prevents late settlement; paper resume preserves holdings', async () => {
    const { id, bot } = await seed();
    const d = await decision(id, '0.8');
    const source = provider();
    const blocked: PaperQuoteProvider = {
      ...source,
      quote: async (request) => {
        const q = await source.quote(request);
        await pool.query("UPDATE bots SET mode='off' WHERE id=$1", [bot]);
        return q;
      },
    };
    const r = await execute(d, MODEL, blocked);
    expect(r.status).toBe('cancelled');
    expect((await state(id)).remaining_raw).toBe('1000000000');
  });
  it('insufficient paper fee cash never fabricates an exit fill', async () => {
    const { id } = await seed({ bankroll: '0' });
    const d = await decision(id, '0.8');
    const r = await execute(d, { ...MODEL, fees: { ...MODEL.fees, networkLamports: '5000' } });
    expect(r.reason).toBe('INSUFFICIENT_PAPER_SOL');
    expect((await state(id)).remaining_raw).toBe('1000000000');
  });
  it('crash after committed fill catches up progress exactly once on next worker', async () => {
    const { id } = await seed();
    const d = await decision(id, '1.3');
    await new PaperBroker(pool, provider(), MODEL).execute(d.intent!, 'crash-fill');
    expect((await state(id)).filled_steps).toEqual([]);
    const next = await decision(id);
    expect(next.intent).toBeUndefined();
    expect((await state(id)).filled_steps).toEqual(['400000000', '0']);
  });
  it('migration0014 rolls down and up without editing older migrations', async () => {
    await migrateDown(pool, (await loadMigrations()).filter((m) => m.version >= '0014').length);
    expect((await migrationStatus(pool)).find((x) => x.version === '0014')?.appliedAt).toBeNull();
    await migrateUp(pool);
    expect(
      (await migrationStatus(pool)).find((x) => x.version === '0014')?.appliedAt,
    ).toBeInstanceOf(Date);
  });
  it('entry partial remainder is cancelled before original basis freezes; late result cannot add tokens', async () => {
    // Use a separate bot because seeded immutable policy correctly prevents deleting its history.
    const other = await seed();
    const oid = randomUUID();
    const entry: ApprovedOrderIntent = {
      orderId: oid,
      clientOrderId: `entry:${oid}`,
      botId: other.bot,
      positionId: null,
      tokenMint: MINT,
      side: 'buy',
      mode: 'paper',
      amountInRaw: '1000000000',
      maxSlippageBps: 300,
      expiresAt: Date.now() + 60000,
      approval: { kind: 'manual_paper_scenario', reference: 'test' },
      quoteRequirements: {
        freshnessPolicy: 'bounded_request_age',
        maxAgeMs: 5000,
        maxSlotLag: 0,
        fullyObservedCosts: false,
      },
      entry: { stopPriceSol: '0.8', takeProfit: [{ atGain: 0.3, sellFraction: 0.4 }] },
      closeReason: null,
    };
    // A new mint identity is not substituted: close the seed fixture before acquiring the actual broker position.
    await pool.query(
      "UPDATE positions SET status='closed',remaining_raw=0,closed_at=clock_timestamp(),close_reason='manual' WHERE id=$1",
      [other.id],
    );
    await pool.query(
      "INSERT INTO orders(id,client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,'buy','paper',$5,300,'TEST_ENTRY')",
      [oid, entry.clientOrderId, other.bot, MINT, entry.amountInRaw],
    );
    await registerPaperIntent(pool, entry);
    const b = new PaperBroker(pool, provider(), { ...MODEL, partialFillBps: 5000 });
    await b.execute(entry, 'partial-entry');
    const actual = (
      await pool.query<{ position_id: string }>(
        'SELECT position_id FROM paper_execution_positions WHERE order_id=$1',
        [oid],
      )
    ).rows[0]!.position_id;
    let entered!: () => void, unblock!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const source = provider();
    const racing = new PaperBroker(
      pool,
      {
        ...source,
        quote: async (request) => {
          entered();
          await gate;
          return source.quote(request);
        },
      },
      { ...MODEL, partialFillBps: 5000 },
    );
    const late = racing.execute(entry, 'late-entry');
    await started;
    const d = await decision(actual, '0.1');
    expect((await state(actual)).original_raw).toBe('1000000000');
    expect((await pool.query('SELECT status FROM orders WHERE id=$1', [oid])).rows[0]!.status).toBe(
      'cancelled',
    );
    unblock();
    expect((await late).status).toBe('cancelled');
    await execute(d);
    expect((await state(actual)).remaining_raw).toBe('0');
  });
  it('closed position crash recovers the final fill receipt even though it is no longer watch eligible', async () => {
    const { id } = await seed();
    const d = await decision(id, '0.8');
    await new PaperBroker(pool, provider(), MODEL).execute(d.intent!, 'crash-close');
    expect((await pool.query('SELECT * FROM position_exit_fill_receipts')).rows).toHaveLength(0);
    await new PositionExitManager(pool, provider()).once();
    await new PositionExitManager(pool, provider()).once();
    expect((await pool.query('SELECT * FROM position_exit_fill_receipts')).rows).toHaveLength(1);
    expect((await state(id)).status).toBe('closed');
  });
  it('legacy adoption preserves saved stop/ladder and occurs only once', async () => {
    await migrateDown(pool, (await loadMigrations()).filter((m) => m.version >= '0014').length);
    const { id } = await seed({ stop: '0.7' });
    await migrateUp(pool);
    const before = (
      await pool.query('SELECT * FROM position_exit_policies WHERE position_id=$1', [id])
    ).rows[0]!;
    expect(before.adopted).toBe(true);
    expect(before.policy.stopPriceSol).toBe('0.7');
    await pool.query("UPDATE risk_profiles SET trailing_stop_fraction=0.1 WHERE id='balanced'");
    expect(
      (await pool.query('SELECT policy FROM position_exit_policies WHERE position_id=$1', [id]))
        .rows[0]!.policy,
    ).toEqual(before.policy);
  });
  it('snapshot/decision/observation/fill receipt history is immutable', async () => {
    const { id } = await seed();
    const d = await decision(id, '1.3');
    await execute(d);
    for (const table of [
      'position_exit_policies',
      'position_exit_decisions',
      'position_exit_observations',
      'position_exit_fill_receipts',
    ]) {
      await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow('append-only');
    }
  });
  it('untrusted older or different holding-amount observations cannot create price exits', async () => {
    const { id } = await seed();
    const owner = randomUUID();
    const p = (await claimExitPosition(pool, id, owner))!;
    const q = observation('0.1', 0, p);
    q.inputRaw = '1';
    expect(await decidePositionExit(pool, p, owner, q)).toBeUndefined();
    expect((await pool.query('SELECT * FROM position_exit_observations')).rows).toHaveLength(0);
    expect((await state(id)).high_n).toBe('0');
  });
  it('small numeric exponent fractions retain integer precision', async () => {
    expect(decimalRatio(0.0000001)).toEqual([1n, 10000000n]);
    const { id } = await seed({
      quantity: '10000000000000000',
      ladder: [{ atGain: 0.3, sellFraction: 0.0000001 }],
    });
    expect((await decision(id, '1.3')).intent?.amountInRaw).toBe('1000000000');
  });
  it('actual exit once/inspect CLI uses local HTTP MODEL quotes and PostgreSQL broker fills', async () => {
    const { id, bot } = await seed();
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      const request: QuoteRequest = {
        intent: {
          side: 'sell',
          tokenMint: MINT,
          maxSlippageBps: Number(url.searchParams.get('slippageBps')),
        } as ApprovedOrderIntent,
        inputRaw: url.searchParams.get('amount')!,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(quoteJson(request)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER');
    try {
      const run = (args: string[]) =>
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            '--conditions=@memebots/source',
            resolve('apps/engine/src/exits/cli.ts'),
            ...args,
          ],
          {
            cwd: resolve('.'),
            env: {
              ...process.env,
              DATABASE_URL: TEST_DATABASE_URL,
              PAPER_QUOTE_MOCK_URL: `http://127.0.0.1:${address.port}`,
            },
          },
        );
      const once = await run(['once', bot]);
      expect(once.stdout).toContain('"status":"filled"');
      expect((await state(id)).filled_steps).toEqual(['400000000', '300000000']);
      const inspected = await run(['inspect', id]);
      expect(inspected.stdout).toContain('"kind":"exit_manager"');
      expect(inspected.stdout).toContain('net_exchange_less_fee_MODEL_v1');
      expect((await pool.query('SELECT count(*)::integer n FROM fills')).rows[0]!.n).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }, 15000);
  it('a failed protective exit stays latched when a later quote rebounds across TP', async () => {
    const { id } = await seed();
    let d = await decision(id, '0.8');
    await execute(d, { ...MODEL, failureProbability: 1 });
    d = await decision(id, '2');
    expect(d.intent?.closeReason).toBe('stop_loss');
    expect(d.intent?.amountInRaw).toBe('1000000000');
    await execute(d);
    expect((await state(id)).remaining_raw).toBe('0');
    expect(await exitAuthorityValid(pool, d.intent!)).toBe(false);
  });
  it.each(['0.000004', '0.000005'])(
    'valid sell proceeds %s at or below MODEL fees still trigger and fill the protective exit',
    async (price) => {
      const { id } = await seed({ bankroll: '10000000000' });
      const outcome = (await new PositionExitManager(pool, provider(price)).once())[0]!;
      expect(outcome.result).toMatchObject({
        status: 'filled',
        networkFeeLamports: '5000',
        outputRaw: price === '0.000004' ? '4000' : '5000',
      });
      const saved = await state(id);
      expect(saved.status).toBe('closed');
      expect(saved.close_reason).toBe('stop_loss');
      expect(saved.high_n).toBe('0');
      expect(saved.high_d).toBe('1');
      const observations = (
        await pool.query('SELECT evidence FROM position_exit_observations WHERE position_id=$1', [
          id,
        ])
      ).rows;
      expect(observations).toHaveLength(1);
      expect(observations[0]!.evidence.numerator).toBe('0');
      expect(saved.filled_steps).toEqual(['0', '0']);
    },
  );
  it('a later zero-unit TP completion cannot restore an already-filled step, including after restart', async () => {
    const { id } = await seed({ quantity: '3' });
    const first = await decision(id, '1.3');
    expect(first.intent?.amountInRaw).toBe('1');
    await execute(first);
    const remaining = async () =>
      (await pool.query('SELECT take_profit_remaining FROM positions WHERE id=$1', [id])).rows[0]!
        .take_profit_remaining;
    expect(await remaining()).toEqual([]);
    expect((await state(id)).filled_steps).toEqual(['1', '0']);
    const restarted = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      const dust = await decision(id, '1.6', restarted);
      expect(dust.intent).toBeUndefined();
      await releaseExitLease(restarted, dust.p, dust.owner);
      expect((await state(id)).dust_steps).toEqual([1]);
      expect(await remaining()).toEqual([]);
      const again = await decision(id, '1.6', restarted);
      expect(again.intent).toBeUndefined();
      await releaseExitLease(restarted, again.p, again.owner);
      expect(await remaining()).toEqual([]);
      expect((await state(id)).filled_steps).toEqual(['1', '0']);
      expect(
        (
          await pool.query("SELECT * FROM audit_log WHERE action='exit.tp_dust' AND entity_id=$1", [
            id,
          ])
        ).rows,
      ).toHaveLength(1);
      expect((await pool.query('SELECT * FROM fills')).rows).toHaveLength(1);
    } finally {
      await restarted.end();
    }
  });
});

import { createHash } from 'node:crypto';
import {
  ceilDiv,
  decimalRatio,
  fractionFloor,
  netRewardRisk,
  protectedStopProceeds,
} from '@memebots/core';
import type {
  ApprovedOrderIntent,
  ExecutionResult,
  PaperModel,
  QuoteEvidence,
} from '@memebots/core';
import { recordAudit } from './audit.js';
import { withTransaction } from './pool.js';
import type { Pool, Queryable } from './pool.js';

export function riskCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(riskCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${riskCanonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function riskHash(value: unknown): string {
  return createHash('sha256').update(riskCanonical(value)).digest('hex');
}
export async function recordRiskBoundaryVeto(
  db: Queryable,
  intent: ApprovedOrderIntent,
  code: string,
  stage: string,
): Promise<void> {
  if (intent.approval.kind !== 'risk_manager') return;
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO risk_decisions(scope,request_key,request_hash,bot_id,status,code)
   VALUES($1,gen_random_uuid()::text,$2,$3,'vetoed',$4) RETURNING id`,
      [riskHash(intent.botId), riskHash(intent), intent.botId, code],
    )
  ).rows[0]!.id;
  await recordAudit(db, {
    actor: 'system',
    action: 'risk.vetoed',
    entityType: 'risk_decision',
    entityId: id,
    details: { code, stage, orderId: intent.orderId },
  });
}
/** A preparation/registration denial rolled back all business writes; persist its
 * decision+audit together before returning the fixed denial to the caller. */
export async function auditRiskBoundaryError(
  pool: Pool,
  intent: ApprovedOrderIntent,
  error: unknown,
  stage: string,
): Promise<never> {
  const codes = [
    'RISK_RECEIPT_REQUIRED',
    'RISK_AUTHORIZATION_STALE',
    'RISK_AUTHORIZATION_EXPIRED',
    'RISK_MODEL_MISMATCH',
    'PAPER_CAP_EXCEEDED',
    'DAILY_LOSS_LIMIT',
    'INSUFFICIENT_PAPER_CASH',
    'ATTEMPT_LIMIT',
    'LOSING_STREAK_LIMIT',
    'RISK_ORDER_TERMINAL',
  ];
  if (
    intent.approval.kind === 'risk_manager' &&
    error instanceof Error &&
    codes.includes(error.message)
  )
    await withTransaction(pool, async (db) => {
      await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [intent.botId]);
      await recordRiskBoundaryVeto(db, intent, error.message, stage);
      if (!['RISK_RECEIPT_REQUIRED', 'RISK_MODEL_MISMATCH'].includes(error.message))
        await db.query(
          "UPDATE orders SET status='cancelled',failure_reason=$2 WHERE id=$1 AND status IN ('pending','partially_filled')",
          [intent.orderId, error.message],
        );
    });
  throw error;
}
export function riskConfigHash(bot: {
  strategy: string;
  strategy_params: unknown;
  risk_profile_id: string;
  mode: string;
  wallet_id?: string;
}): string {
  return riskHash([
    bot.strategy,
    bot.strategy_params,
    bot.risk_profile_id,
    bot.mode,
    bot.wallet_id ?? null,
  ]);
}
/** Caller must already hold the bot row. First UTC observation snapshots book capital, never marks. */
export async function ensureRiskDay(
  db: Queryable,
  botId: string,
): Promise<{ day: string; limit: bigint; used: bigint; now: number }> {
  const info = (
    await db.query<{ day: string; now: string; cash: string; basis: string; fraction: string }>(
      `SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS "day", (extract(epoch FROM clock_timestamp())*1000)::bigint::text now,
     b.paper_bankroll_lamports::text cash, COALESCE((SELECT sum(cost_lamports) FROM positions WHERE bot_id=b.id AND mode='paper' AND status='open'),0)::text basis,
     p.daily_loss_limit_fraction::text fraction FROM bots b JOIN risk_profiles p ON p.id=b.risk_profile_id WHERE b.id=$1`,
      [botId],
    )
  ).rows[0]!;
  const book = BigInt(info.cash) + BigInt(info.basis),
    limit = fractionFloor(book, info.fraction);
  const added = await db.query(
    `INSERT INTO risk_days(bot_id,day,opening_book_lamports,limit_lamports) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING day`,
    [botId, info.day, book.toString(), limit.toString()],
  );
  if (added.rowCount)
    await recordAudit(db, {
      actor: 'system',
      action: 'risk.day_opened',
      entityType: 'bot',
      entityId: botId,
      details: {
        day: info.day,
        openingBookLamports: book.toString(),
        limitLamports: limit.toString(),
      },
    });
  const day = (
    await db.query<{
      opening_book_lamports: string;
      limit_lamports: string;
      loss_used_lamports: string;
    }>('SELECT * FROM risk_days WHERE bot_id=$1 AND day=$2', [botId, info.day])
  ).rows[0]!;
  const adjusted = fractionFloor(BigInt(day.opening_book_lamports), info.fraction);
  return {
    day: info.day,
    now: Number(info.now),
    limit: adjusted < BigInt(day.limit_lamports) ? adjusted : BigInt(day.limit_lamports),
    used: BigInt(day.loss_used_lamports),
  };
}
export async function riskExposure(
  db: Queryable,
  botId: string,
): Promise<{ debit: bigint; loss: bigint; feeCash: bigint }> {
  const row = (
    await db.query<{ debit: string; loss: string; fee: string }>(
      `SELECT
   COALESCE((SELECT sum(debit_remaining) FROM risk_reservations WHERE bot_id=$1 AND state='active'),0)::text debit,
   (COALESCE((SELECT sum(loss_remaining) FROM risk_reservations WHERE bot_id=$1 AND state='active'),0)+COALESCE((SELECT sum(loss_remaining) FROM risk_position_commitments WHERE bot_id=$1),0))::text loss,
   COALESCE((SELECT sum(fee_cash) FROM risk_position_commitments WHERE bot_id=$1),0)::text fee`,
      [botId],
    )
  ).rows[0]!;
  return { debit: BigInt(row.debit), loss: BigInt(row.loss), feeCash: BigInt(row.fee) };
}
export async function setPaperRiskCap(pool: Pool, botId: string, cap: string): Promise<void> {
  if (!/^(0|[1-9]\d{0,38})$/.test(cap)) throw new Error('INVALID_PAPER_CAP');
  await withTransaction(pool, async (db) => {
    if (!(await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId])).rowCount)
      throw new Error('BOT_NOT_FOUND');
    const old = (
      await db.query<{ consumed_lamports: string }>(
        'SELECT * FROM risk_paper_accounts WHERE bot_id=$1',
        [botId],
      )
    ).rows[0];
    const held = await riskExposure(db, botId);
    if (BigInt(cap) < BigInt(old?.consumed_lamports ?? '0') + held.debit + held.feeCash)
      throw new Error('PAPER_CAP_BELOW_COMMITMENT');
    await db.query(
      'INSERT INTO risk_paper_accounts(bot_id,cap_lamports) VALUES($1,$2) ON CONFLICT(bot_id) DO UPDATE SET cap_lamports=EXCLUDED.cap_lamports',
      [botId, cap],
    );
    await recordAudit(db, {
      actor: 'owner',
      action: 'risk.paper_cap_changed',
      entityType: 'bot',
      entityId: botId,
      details: { capLamports: cap },
    });
  });
}

/** Full immutable receipt is authority; the string marker alone confers none. Bot lock required. */
export async function riskAdmissionFailure(
  db: Queryable,
  intent: ApprovedOrderIntent,
  model?: PaperModel,
  preparing = true,
): Promise<string | null> {
  if (intent.approval.kind !== 'risk_manager') return null;
  const row = (
    await db.query<{
      intent: ApprovedOrderIntent;
      model: PaperModel;
      profile_revision: string;
      revision: string;
      config_hash: string;
      strategy: string;
      strategy_params: unknown;
      risk_profile_id: string;
      mode: string;
      wallet_id: string;
      expires: string;
      state: string;
      debit_remaining: string;
      consumed: string;
      cap: string;
      wallet_cap: string | null;
      max_attempts: number;
      snapshot_expiry: Date;
      current_snapshot: string | null;
      order_status: string;
      snapshot_id: string;
      cash: string;
    }>(
      `SELECT a.*,o.status order_status, p.revision::text, b.strategy,b.strategy_params,b.risk_profile_id,b.mode,b.wallet_id,
    (extract(epoch FROM a.expires_at)*1000)::bigint::text expires,r.state,r.debit_remaining,
    c.consumed_lamports::text consumed,c.cap_lamports::text cap,w.spend_cap_lamports::text wallet_cap,s.expires_at snapshot_expiry,
    b.paper_bankroll_lamports::text cash,(SELECT snapshot_id::text FROM token_safety_cache WHERE cache_key=s.cache_key) current_snapshot
    FROM risk_admissions a JOIN orders o ON o.id=a.order_id JOIN risk_reservations r ON r.admission_id=a.id JOIN bots b ON b.id=a.bot_id
    JOIN risk_profiles p ON p.id=b.risk_profile_id JOIN risk_paper_accounts c ON c.bot_id=b.id
    JOIN wallets w ON w.id=b.wallet_id JOIN token_safety_snapshots s ON s.id=a.snapshot_id
    WHERE a.id::text=$1 AND a.order_id=$2`,
      [intent.approval.reference, intent.orderId],
    )
  ).rows[0];
  if (!row || riskCanonical(row.intent) !== riskCanonical(intent)) return 'RISK_RECEIPT_REQUIRED';
  if (!['pending', 'partially_filled'].includes(row.order_status)) return 'RISK_ORDER_TERMINAL';
  await db.query('SELECT id FROM risk_profiles WHERE id=$1 FOR SHARE', [row.risk_profile_id]);
  // Re-read revisions after acquiring the profile lock; an edit may have won the race.
  const lockedProfile = (
    await db.query<{ revision: string; losing_streak_limit: number }>(
      'SELECT revision::text,losing_streak_limit FROM risk_profiles WHERE id=$1',
      [row.risk_profile_id],
    )
  ).rows[0]!;
  await db.query(
    'SELECT cache_key FROM token_safety_cache WHERE cache_key=(SELECT cache_key FROM token_safety_snapshots WHERE id=$1) FOR SHARE',
    [row.snapshot_id],
  );
  const lockedSnapshot = (
    await db.query<{ snapshot_id: string }>(
      'SELECT snapshot_id FROM token_safety_cache WHERE cache_key=(SELECT cache_key FROM token_safety_snapshots WHERE id=$1)',
      [row.snapshot_id],
    )
  ).rows[0]?.snapshot_id;
  const day = await ensureRiskDay(db, intent.botId);
  if (
    row.mode !== 'paper' ||
    row.config_hash !== riskConfigHash(row) ||
    row.profile_revision.toString() !== lockedProfile.revision ||
    row.state !== 'active' ||
    lockedSnapshot !== row.snapshot_id
  )
    return 'RISK_AUTHORIZATION_STALE';
  if (day.now >= Number(row.expires) || day.now >= row.snapshot_expiry.getTime())
    return 'RISK_AUTHORIZATION_EXPIRED';
  if (model && riskCanonical(model) !== riskCanonical(row.model)) return 'RISK_MODEL_MISMATCH';
  const streak =
    (
      await db.query<{ losses: number }>('SELECT losses FROM risk_streaks WHERE bot_id=$1', [
        intent.botId,
      ])
    ).rows[0]?.losses ?? 0;
  if (streak >= lockedProfile.losing_streak_limit) return 'LOSING_STREAK_LIMIT';
  const exposure = await riskExposure(db, intent.botId);
  if (BigInt(row.cash) < exposure.debit + exposure.feeCash) return 'INSUFFICIENT_PAPER_CASH';
  const cap = BigInt(row.cap);
  if (
    row.wallet_cap === null ||
    BigInt(row.consumed) + exposure.debit + exposure.feeCash > cap ||
    BigInt(row.consumed) + exposure.debit + exposure.feeCash > BigInt(row.wallet_cap)
  )
    return 'PAPER_CAP_EXCEEDED';
  if (day.used + exposure.loss > day.limit) return 'DAILY_LOSS_LIMIT';
  const attempts = (
    await db.query<{ n: string }>(
      'SELECT count(*)::text n FROM paper_execution_attempts WHERE order_id=$1',
      [intent.orderId],
    )
  ).rows[0]!;
  if (model && preparing && BigInt(attempts.n) >= BigInt(row.max_attempts)) return 'ATTEMPT_LIMIT';
  return null;
}

export async function beginRiskSettlement(
  db: Queryable,
  botId: string,
): Promise<Awaited<ReturnType<typeof ensureRiskDay>> | undefined> {
  if (
    (await db.query<{ table: string | null }>("SELECT to_regclass('risk_days')::text AS table"))
      .rows[0]?.table
  )
    return ensureRiskDay(db, botId);
}

/** Managed paper accounts also protect reserved cash/cap from owner/manual orders.
 * Unmanaged owner demo bots retain their explicit manual exception. */
export async function riskSpendFailure(
  db: Queryable,
  input: {
    botId: string;
    orderId: string;
    positionId: string | undefined;
    debit: bigint;
    closes: boolean;
  },
): Promise<string | null> {
  if (
    !(await db.query<{ t: string | null }>("SELECT to_regclass('risk_paper_accounts')::text t"))
      .rows[0]?.t
  )
    return null;
  const account = (
    await db.query<{ cap: string; consumed: string; cash: string; wallet_cap: string | null }>(
      `SELECT c.cap_lamports::text cap,c.consumed_lamports::text consumed,b.paper_bankroll_lamports::text cash,w.spend_cap_lamports::text wallet_cap FROM risk_paper_accounts c JOIN bots b ON b.id=c.bot_id JOIN wallets w ON w.id=b.wallet_id WHERE c.bot_id=$1`,
      [input.botId],
    )
  ).rows[0];
  if (!account) return null;
  const exposure = await riskExposure(db, input.botId);
  const own = (
    await db.query<{ debit: string }>(
      `SELECT r.debit_remaining::text debit FROM risk_reservations r JOIN risk_admissions a ON a.id=r.admission_id WHERE a.order_id=$1 AND r.state='active'`,
      [input.orderId],
    )
  ).rows[0];
  const position =
    input.closes && input.positionId
      ? (
          await db.query<{ fee_cash: string }>(
            'SELECT fee_cash FROM risk_position_commitments WHERE position_id=$1',
            [input.positionId],
          )
        ).rows[0]
      : undefined;
  const protectedCash =
    exposure.debit +
    exposure.feeCash -
    BigInt(own?.debit ?? '0') -
    BigInt(position?.fee_cash ?? '0');
  if (BigInt(account.cash) < input.debit + protectedCash) return 'PAPER_CASH_RESERVED';
  if (
    account.wallet_cap === null ||
    BigInt(account.consumed) + input.debit + protectedCash > BigInt(account.cap) ||
    BigInt(account.consumed) + input.debit + protectedCash > BigInt(account.wallet_cap)
  )
    return 'PAPER_CAP_EXCEEDED';
  return null;
}

/** New quotes must preserve the approved amount-proportional token floor. */
export async function riskQuoteFailure(
  db: Queryable,
  intent: ApprovedOrderIntent,
  input: string,
  evidence: QuoteEvidence | undefined,
  candidate?: ExecutionResult,
): Promise<string | null> {
  if (intent.approval.kind !== 'risk_manager' || evidence?.status !== 'available') return null;
  const approved = (
    await db.query<{
      assumptions: {
        entryQuote: { minimumOutputRaw: string };
        target: { priceSol: string };
        economicsPolicy: {
          decimals: number;
          minRR: string;
          stopFraction: string;
          slippageBps: number;
          adverseBps: number;
          entryFeeBudget: string;
          exitFee: string;
        };
      };
      principal_lamports: string;
    }>('SELECT assumptions,principal_lamports FROM risk_admissions WHERE order_id=$1', [
      intent.orderId,
    ])
  ).rows[0];
  if (
    !approved ||
    BigInt(evidence.quote.minimumOutputRaw) * BigInt(approved.principal_lamports) <
      BigInt(approved.assumptions.entryQuote.minimumOutputRaw) * BigInt(input)
  )
    return 'RISK_QUOTE_MOVED';
  if (candidate && ['filled', 'partial'].includes(candidate.status)) {
    const position = (
      await db.query<{ quantity_raw: string; remaining_raw: string }>(
        `SELECT p.quantity_raw,p.remaining_raw FROM paper_execution_positions x JOIN positions p ON p.id=x.position_id WHERE x.order_id=$1`,
        [intent.orderId],
      )
    ).rows[0];
    if (position && position.quantity_raw !== position.remaining_raw)
      return 'RISK_POSITION_REDUCED';
    const prior = (
      await db.query<{ principal: string; quantity: string }>(
        `SELECT COALESCE(sum((result->>'inputRaw')::numeric),0)::text principal,COALESCE(sum((result->>'outputRaw')::numeric),0)::text quantity FROM paper_execution_results WHERE order_id=$1 AND result->>'status' IN ('filled','partial')`,
        [intent.orderId],
      )
    ).rows[0]!;
    const policy = approved.assumptions.economicsPolicy;
    const economics = netRewardRisk({
      principal: BigInt(prior.principal) + BigInt(input),
      quantity: BigInt(prior.quantity) + BigInt(candidate.outputRaw),
      decimals: policy.decimals,
      targetPriceSol: approved.assumptions.target.priceSol,
      stopFraction: policy.stopFraction,
      stopPriceSol: intent.entry!.stopPriceSol,
      slippageBps: policy.slippageBps,
      adverseBps: policy.adverseBps,
      entryFees: BigInt(policy.entryFeeBudget),
      exitFees: BigInt(policy.exitFee),
    });
    const rr = decimalRatio(policy.minRR);
    if (economics.reward < 0n || economics.reward * rr.d < economics.loss * rr.n)
      return 'MIN_REWARD_RISK';
  }
  return null;
}

/** Exactly one immutable risk veto for the final no-fill outcome of every risk
 * attempt. Called with the durable result in the same settlement transaction. */
export async function recordFinalRiskVeto(
  db: Queryable,
  intent: ApprovedOrderIntent,
  result: ExecutionResult,
): Promise<void> {
  if (intent.approval.kind !== 'risk_manager' || ['filled', 'partial'].includes(result.status))
    return;
  const exposure = await riskExposure(db, intent.botId);
  const metrics = {
    networkFeeLamports: result.networkFeeLamports,
    priorityFeeLamports: result.priorityFeeLamports,
    reservedDebit: exposure.debit.toString(),
    reservedLoss: exposure.loss.toString(),
  };
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO risk_decisions(scope,request_key,request_hash,bot_id,status,code,metrics,execution_attempt_id) VALUES($1,gen_random_uuid()::text,$2,$3,'vetoed',$4,$5,$6) ON CONFLICT(execution_attempt_id) DO NOTHING RETURNING id`,
      [
        riskHash(intent.botId),
        riskHash([intent, result]),
        intent.botId,
        result.reason,
        JSON.stringify(metrics),
        result.attemptId,
      ],
    )
  ).rows[0];
  if (row)
    await recordAudit(db, {
      actor: 'system',
      action: 'risk.vetoed',
      entityType: 'risk_decision',
      entityId: row.id,
      details: {
        code: result.reason,
        stage: 'settlement',
        orderId: intent.orderId,
        attemptId: result.attemptId,
        metrics,
      },
    });
}

/** Cancel expired/config-stale pending receipts under bot-first locking; late settlements become zero. */
export async function reconcileRiskAdmissions(pool: Pool, botId: string): Promise<void> {
  await withTransaction(pool, async (db) => {
    await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId]);
    const orders = await db.query<{ id: string; intent: ApprovedOrderIntent }>(
      `SELECT o.id,a.intent FROM orders o JOIN risk_admissions a ON a.order_id=o.id JOIN risk_reservations r ON r.admission_id=a.id WHERE o.bot_id=$1 AND r.state='active' ORDER BY o.id FOR UPDATE OF o`,
      [botId],
    );
    for (const order of orders.rows) {
      const failure = await riskAdmissionFailure(db, order.intent);
      if (!failure) continue;
      await recordRiskBoundaryVeto(db, order.intent, failure, 'reconcile');
      await db.query(
        "UPDATE orders SET status='cancelled',failure_reason=$2 WHERE id=$1 AND status IN ('pending','partially_filled')",
        [order.id, failure],
      );
      await db.query(
        "UPDATE risk_reservations SET state='terminal',debit_remaining=0,loss_remaining=0 WHERE admission_id=$1",
        [order.intent.approval.reference],
      );
      await recordAudit(db, {
        actor: 'system',
        action: 'risk.admission_released',
        entityType: 'order',
        entityId: order.id,
        details: { code: failure },
      });
    }
  });
}

export interface RiskSettlementContext {
  botId: string;
  orderId: string;
  attemptId: string;
  side: 'buy' | 'sell';
  model: PaperModel;
  result: ExecutionResult;
  positionBefore: { id: string; remaining_raw: string; cost_lamports: string } | undefined;
  day?: Awaited<ReturnType<typeof ensureRiskDay>> | undefined;
}
/** Called once in the broker transaction AFTER immutable result insertion. No pool/IO reentry. */
export async function reconcileRiskSettlement(
  db: Queryable,
  context: RiskSettlementContext,
): Promise<void> {
  if (
    !(
      await db.query<{ table: string | null }>(
        "SELECT to_regclass('risk_pnl_events')::text AS table",
      )
    ).rows[0]?.table
  )
    return;
  const { result, model, botId, orderId, attemptId, side, positionBefore } = context;
  const position = (
    await db.query<{
      id: string;
      remaining_raw: string;
      cost_lamports: string;
      status: string;
      realized_pnl_lamports: string;
      stop_price_sol: string;
      decimals: number;
    }>(
      `SELECT p.*,t.decimals FROM positions p JOIN tokens t ON t.mint=p.token_mint WHERE p.id=COALESCE($1::uuid,(SELECT position_id FROM paper_execution_positions WHERE order_id=$2))`,
      [positionBefore?.id ?? null, orderId],
    )
  ).rows[0];
  const fills = ['filled', 'partial'].includes(result.status),
    fees = BigInt(result.networkFeeLamports) + BigInt(result.priorityFeeLamports);
  const input = fills ? BigInt(result.inputRaw) : 0n,
    output = fills ? BigInt(result.outputRaw) : 0n;
  const day = context.day ?? (await ensureRiskDay(db, botId));
  let pnl = -fees;
  if (fills && side === 'buy') pnl = 0n; // Buy fees are allocated through exact position basis on each sale.
  if (fills && side === 'sell')
    pnl =
      output -
      ceilDiv(
        BigInt(positionBefore!.cost_lamports) * input,
        BigInt(positionBefore!.remaining_raw),
      ) -
      fees;
  const closed = fills && side === 'sell' && position?.status === 'closed';
  const inserted = await db.query(
    'INSERT INTO risk_pnl_events(attempt_id,bot_id,position_id,day,realized_lamports,closed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING attempt_id',
    [attemptId, botId, position?.id ?? null, day.day, pnl.toString(), closed],
  );
  if (!inserted.rowCount) return;
  if (pnl < 0n)
    await db.query(
      'UPDATE risk_days SET loss_used_lamports=loss_used_lamports+$3::numeric WHERE bot_id=$1 AND day=$2',
      [botId, day.day, (-pnl).toString()],
    );
  await db.query(
    'UPDATE risk_paper_accounts SET consumed_lamports=consumed_lamports+$2::numeric WHERE bot_id=$1',
    [botId, ((side === 'buy' ? input : 0n) + fees).toString()],
  );
  const receipt = (
    await db.query<{
      id: string;
      principal_lamports: string;
      loss_lamports: string;
      max_attempts: number;
      intent: ApprovedOrderIntent;
      assumptions: {
        entryQuote: { minimumOutputRaw: string };
        economicsPolicy: { decimals: number; slippageBps: number; adverseBps: number };
      };
    }>('SELECT * FROM risk_admissions WHERE order_id=$1', [orderId])
  ).rows[0];
  if (receipt) {
    const sums = (
      await db.query<{ spent: string; fees: string; attempts: string }>(
        `SELECT COALESCE(sum(CASE WHEN r.result->>'status' IN ('filled','partial') THEN (r.result->>'inputRaw')::numeric ELSE 0 END),0)::text spent,
     COALESCE(sum((r.result->>'networkFeeLamports')::numeric+(r.result->>'priorityFeeLamports')::numeric),0)::text fees,count(*)::text attempts FROM paper_execution_results r WHERE order_id=$1`,
        [orderId],
      )
    ).rows[0]!;
    const remaining = BigInt(receipt.principal_lamports) - BigInt(sums.spent);
    const pending =
      ['partial', 'unavailable'].includes(result.status) &&
      BigInt(sums.attempts) < BigInt(receipt.max_attempts);
    const fee = BigInt(model.fees.networkLamports) + BigInt(model.fees.priorityLamports);
    const feeRemaining = fee * (BigInt(receipt.max_attempts) - BigInt(sums.attempts));
    const policy = receipt.assumptions.economicsPolicy;
    const currentQuantity = position ? BigInt(position.remaining_raw) : 0n;
    const futureMinimum = ceilDiv(
      BigInt(receipt.assumptions.entryQuote.minimumOutputRaw) * remaining,
      BigInt(receipt.principal_lamports),
    );
    const protectedBefore = protectedStopProceeds(
      currentQuantity,
      policy.decimals,
      receipt.intent.entry!.stopPriceSol,
      policy.slippageBps,
      policy.adverseBps,
    );
    const protectedAfter = protectedStopProceeds(
      currentQuantity + futureMinimum,
      policy.decimals,
      receipt.intent.entry!.stopPriceSol,
      policy.slippageBps,
      policy.adverseBps,
    );
    const incrementalStopRisk =
      remaining > protectedAfter - protectedBefore
        ? remaining - (protectedAfter - protectedBefore)
        : 0n;
    const reservedLoss = incrementalStopRisk + feeRemaining + (position ? 0n : fee);
    if (!pending && ['partial', 'unavailable'].includes(result.status))
      await db.query(
        "UPDATE orders SET status='cancelled',failure_reason='RISK_ATTEMPT_LIMIT' WHERE id=$1",
        [orderId],
      );
    await db.query(
      'UPDATE risk_reservations SET debit_remaining=$2,loss_remaining=$3,state=$4 WHERE admission_id=$1',
      [
        receipt.id,
        pending ? (remaining + feeRemaining + (position ? 0n : fee)).toString() : '0',
        pending ? reservedLoss.toString() : '0',
        pending ? 'active' : 'terminal',
      ],
    );
  }
  if (position) {
    const profile = (
      await db.query<{ stop_loss_fraction: string; max_slippage_bps: number }>(
        `SELECT p.stop_loss_fraction,p.max_slippage_bps FROM bots b JOIN risk_profiles p ON p.id=b.risk_profile_id WHERE b.id=$1`,
        [botId],
      )
    ).rows[0]!;
    const old = (
      await db.query<{ fee_cash: string; max_slippage_bps: number; adverse_bps: number }>(
        'SELECT * FROM risk_position_commitments WHERE position_id=$1',
        [position.id],
      )
    ).rows[0];
    const stop = decimalRatio(position.stop_price_sol),
      basis = BigInt(position.cost_lamports);
    const currentFee = BigInt(model.fees.networkLamports) + BigInt(model.fees.priorityLamports);
    const fee = BigInt(old?.fee_cash ?? '0') > currentFee ? BigInt(old!.fee_cash) : currentFee;
    const slippage = Math.max(old?.max_slippage_bps ?? 0, profile.max_slippage_bps),
      adverse = Math.max(old?.adverse_bps ?? 0, model.adverseSlippageBps);
    const recovered =
      (((((BigInt(position.remaining_raw) * stop.n * 1000000000n) /
        (stop.d * 10n ** BigInt(position.decimals))) *
        BigInt(10000 - slippage)) /
        10000n) *
        BigInt(10000 - adverse)) /
      10000n;
    const commitment =
      position.status === 'closed' ? 0n : (basis > recovered ? basis - recovered : 0n) + fee;
    await db.query(
      'INSERT INTO risk_position_commitments(position_id,bot_id,loss_remaining,fee_cash,max_slippage_bps,adverse_bps) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(position_id) DO UPDATE SET loss_remaining=EXCLUDED.loss_remaining,fee_cash=EXCLUDED.fee_cash,max_slippage_bps=EXCLUDED.max_slippage_bps,adverse_bps=EXCLUDED.adverse_bps',
      [
        position.id,
        botId,
        commitment.toString(),
        position.status === 'closed' ? '0' : fee.toString(),
        slippage,
        adverse,
      ],
    );
    if (closed) {
      const failed = (
        await db.query<{ pnl: string }>(
          `SELECT COALESCE(sum(e.realized_lamports),0)::text pnl FROM risk_pnl_events e JOIN paper_execution_results r USING(attempt_id) WHERE e.position_id=$1 AND r.result->>'status'='failed'`,
          [position.id],
        )
      ).rows[0]!;
      const total = BigInt(position.realized_pnl_lamports) + BigInt(failed.pnl);
      await db.query(
        'INSERT INTO risk_streaks(bot_id,losses) VALUES($1,$2) ON CONFLICT(bot_id) DO UPDATE SET losses=CASE WHEN $3::numeric<0 THEN risk_streaks.losses+1 WHEN $3::numeric>0 THEN 0 ELSE risk_streaks.losses END',
        [botId, total < 0n ? 1 : 0, total.toString()],
      );
    }
  }
}

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateModel, integer } from '@memebots/core';
import type {
  ApprovedOrderIntent,
  ExecutionResult,
  PaperModel,
  PaperDraws,
  QuoteEvidence,
} from '@memebots/core';
import { exitAuthorityValid, exitBuyIsFenced } from './position-exits.js';
import { recordAudit } from './audit.js';
import { withTransaction } from './pool.js';
import type { Pool, Queryable } from './pool.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function amount(v: string): bigint {
  if (!/^[1-9][0-9]{0,38}$/.test(v)) throw new Error('INVALID_INTENT');
  return BigInt(v);
}
export function validatePaperIntent(intent: ApprovedOrderIntent): void {
  if (
    ![intent.orderId, intent.botId].every((x) => UUID.test(x)) ||
    (intent.positionId !== null && !UUID.test(intent.positionId)) ||
    !MINT.test(intent.tokenMint) ||
    intent.tokenMint === 'So11111111111111111111111111111111111111112' ||
    intent.mode !== 'paper' ||
    !['buy', 'sell'].includes(intent.side)
  )
    throw new Error('INVALID_INTENT');
  amount(intent.amountInRaw);
  if (
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(intent.clientOrderId) ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(intent.approval.reference) ||
    !['risk_manager', 'exit_manager', 'manual_paper_scenario'].includes(intent.approval.kind)
  )
    throw new Error('INVALID_APPROVAL');
  if (
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.expiresAt <= 0 ||
    !Number.isSafeInteger(intent.maxSlippageBps) ||
    intent.maxSlippageBps < 0 ||
    intent.maxSlippageBps > 5000
  )
    throw new Error('INVALID_INTENT');
  const q = intent.quoteRequirements;
  if (
    !Number.isSafeInteger(q.maxAgeMs) ||
    q.maxAgeMs < 1 ||
    q.maxAgeMs > (q.freshnessPolicy === 'bounded_request_age' ? 5000 : 60_000) ||
    !Number.isSafeInteger(q.maxSlotLag) ||
    q.maxSlotLag < 0 ||
    q.maxSlotLag > 150 ||
    typeof q.fullyObservedCosts !== 'boolean' ||
    !['bounded_request_age', 'chain_context'].includes(q.freshnessPolicy)
  )
    throw new Error('INVALID_QUOTE_REQUIREMENTS');
  if (
    intent.side === 'buy' &&
    (!intent.entry ||
      !/^(0|[1-9][0-9]*)(\.[0-9]{1,30})?$/.test(intent.entry.stopPriceSol) ||
      intent.entry.takeProfit.length === 0 ||
      intent.entry.takeProfit.length > 20)
  )
    throw new Error('ENTRY_METADATA_REQUIRED');
  if (intent.entry) {
    let total = 0;
    let gain = 0;
    for (const step of intent.entry.takeProfit) {
      if (
        !Number.isFinite(step.atGain) ||
        step.atGain <= gain ||
        !Number.isFinite(step.sellFraction) ||
        step.sellFraction <= 0 ||
        step.sellFraction > 1
      )
        throw new Error('INVALID_ENTRY_METADATA');
      gain = step.atGain;
      total += step.sellFraction;
    }
    if (total > 1.0000000001) throw new Error('INVALID_ENTRY_METADATA');
  }
  if (
    intent.side === 'sell' &&
    (!intent.positionId ||
      ![
        'stop_loss',
        'take_profit',
        'trailing_stop',
        'time_stop',
        'kill_switch',
        'manual',
        'strategy_exit',
      ].includes(intent.closeReason ?? ''))
  )
    throw new Error('EXIT_METADATA_REQUIRED');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
interface OrderRow {
  id: string;
  client_order_id: string;
  bot_id: string;
  position_id: string | null;
  token_mint: string;
  side: string;
  mode: string;
  status: string;
  amount_in_raw: string;
  max_slippage_bps: number;
  veto_reason: string | null;
  bot_mode: string;
  paper_bankroll_lamports: string;
  decimals: number;
}
export async function lockedPaperOrder(db: Queryable, id: string): Promise<OrderRow> {
  const identity = (
    await db.query<{ bot_id: string }>('SELECT bot_id FROM orders WHERE id=$1', [id])
  ).rows[0];
  if (!identity) throw new Error('ORDER_NOT_FOUND');
  await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [identity.bot_id]);
  const { rows } = await db.query<OrderRow>(
    `SELECT o.*, b.mode bot_mode, b.paper_bankroll_lamports, t.decimals FROM orders o JOIN bots b ON b.id=o.bot_id JOIN tokens t ON t.mint=o.token_mint WHERE o.id=$1 FOR UPDATE OF o`,
    [id],
  );
  if (!rows[0]) throw new Error('ORDER_NOT_FOUND');
  return rows[0];
}
function matches(order: OrderRow, intent: ApprovedOrderIntent, requirePaperMode = true): void {
  if (
    order.id !== intent.orderId ||
    order.client_order_id !== intent.clientOrderId ||
    order.bot_id !== intent.botId ||
    order.position_id !== intent.positionId ||
    order.token_mint !== intent.tokenMint ||
    order.side !== intent.side ||
    order.amount_in_raw !== intent.amountInRaw ||
    order.max_slippage_bps !== intent.maxSlippageBps ||
    order.mode !== 'paper' ||
    (requirePaperMode && order.bot_mode !== 'paper') ||
    order.veto_reason !== null ||
    order.status === 'vetoed'
  )
    throw new Error('PERSISTED_ORDER_MISMATCH');
}
export async function registerPaperIntent(pool: Pool, intent: ApprovedOrderIntent): Promise<void> {
  await withTransaction(pool, (db) => registerPaperIntentInTransaction(db, intent));
}
/** Reuse a held bot-first transaction without acquiring another pooled connection. */
export async function registerPaperIntentInTransaction(
  db: Queryable,
  intent: ApprovedOrderIntent,
): Promise<void> {
  validatePaperIntent(intent);
  const order = await lockedPaperOrder(db, intent.orderId);
  matches(order, intent);
  if (order.bot_mode !== 'paper' || !(await exitAuthorityValid(db, intent)))
    throw new Error('APPROVAL_AUTHORITY_REQUIRED');
  if (await exitBuyIsFenced(db, intent)) throw new Error('POSITION_EXIT_FROZEN');
  if (order.status !== 'pending') throw new Error('ORDER_NOT_PENDING');
  const old = await db.query<{ intent: ApprovedOrderIntent }>(
    'SELECT intent FROM paper_execution_intents WHERE order_id=$1',
    [intent.orderId],
  );
  if (old.rows[0]) {
    if (canonical(old.rows[0].intent) !== canonical(intent)) throw new Error('INTENT_IMMUTABLE');
    return;
  }
  await db.query('INSERT INTO paper_execution_intents(order_id,intent) VALUES($1,$2)', [
    intent.orderId,
    JSON.stringify(intent),
  ]);
  await recordAudit(db, {
    actor: intent.approval.kind === 'manual_paper_scenario' ? 'owner' : 'system',
    action: 'paper.intent_registered',
    entityType: 'order',
    entityId: intent.orderId,
    details: { approvalKind: intent.approval.kind, approvalReference: intent.approval.reference },
  });
}
export async function loadPaperIntent(
  db: Queryable,
  orderId: string,
): Promise<ApprovedOrderIntent> {
  const { rows } = await db.query<{ intent: ApprovedOrderIntent }>(
    'SELECT intent FROM paper_execution_intents WHERE order_id=$1',
    [orderId],
  );
  if (!rows[0]) throw new Error('APPROVED_INTENT_REQUIRED');
  validatePaperIntent(rows[0].intent);
  return rows[0].intent;
}
export interface PaperAttempt {
  readonly id: string;
  readonly orderId: string;
  readonly key: string;
  readonly inputRaw: string;
  readonly seed: string;
  readonly model: PaperModel;
  readonly draws: PaperDraws;
  readonly startedAt: number;
  readonly readyAt: number;
}
interface AttemptRow {
  id: string;
  order_id: string;
  idempotency_key: string;
  input_raw: string;
  seed: string;
  model: PaperModel;
  draws: PaperDraws;
  started_at_ms: string;
  ready_at_ms: string;
}
const toAttempt = (r: AttemptRow): PaperAttempt => ({
  id: r.id,
  orderId: r.order_id,
  key: r.idempotency_key,
  inputRaw: r.input_raw,
  seed: r.seed,
  model: r.model,
  draws: r.draws,
  startedAt: Number(r.started_at_ms),
  readyAt: Number(r.ready_at_ms),
});
export async function preparePaperAttempt(
  pool: Pool,
  intent: ApprovedOrderIntent,
  key: string,
  model: PaperModel,
  seed: string,
  draws: PaperDraws,
  now: number,
): Promise<PaperAttempt> {
  validatePaperIntent(intent);
  validateModel(model);
  integer(now, 1, Number.MAX_SAFE_INTEGER - 60000);
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('INVALID_SEED');
  const hash = createHash('sha256').update(`paper-v1:${seed}`).digest();
  if (
    draws.latencyMs !==
      model.minLatencyMs + (hash.readUInt32BE(0) % (model.maxLatencyMs - model.minLatencyMs + 1)) ||
    draws.failurePpm !== hash.readUInt32BE(4) % 1000000
  )
    throw new Error('DRAW_MISMATCH');
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(key)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  return withTransaction(pool, async (db) => {
    const order = await lockedPaperOrder(db, intent.orderId);
    matches(order, intent);
    const persisted = await loadPaperIntent(db, intent.orderId);
    if (canonical(persisted) !== canonical(intent)) throw new Error('INTENT_MISMATCH');
    const existing = await db.query<AttemptRow>(
      'SELECT * FROM paper_execution_attempts WHERE idempotency_key=$1',
      [key],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].order_id !== intent.orderId) throw new Error('IDEMPOTENCY_CONFLICT');
      return toAttempt(existing.rows[0]);
    }
    if (order.bot_mode !== 'paper' || !(await exitAuthorityValid(db, intent)))
      throw new Error('APPROVAL_AUTHORITY_REQUIRED');
    if (await exitBuyIsFenced(db, intent)) throw new Error('POSITION_EXIT_FROZEN');
    if (!['pending', 'partially_filled'].includes(order.status))
      throw new Error('ORDER_NOT_EXECUTABLE');
    const active = await db.query(
      'SELECT a.id FROM paper_execution_attempts a LEFT JOIN paper_execution_results r ON r.attempt_id=a.id WHERE a.order_id=$1 AND r.attempt_id IS NULL',
      [intent.orderId],
    );
    if (active.rows.length) throw new Error('RECOVERY_REQUIRED');
    const prior = await db.query<{ spent: string; sequence: number }>(
      `SELECT COALESCE(sum(CASE WHEN r.result->>'status' IN ('filled','partial') THEN (r.result->>'inputRaw')::numeric ELSE 0 END),0)::text spent, COALESCE(max(a.sequence),0)::integer sequence FROM paper_execution_attempts a LEFT JOIN paper_execution_results r ON r.attempt_id=a.id WHERE a.order_id=$1`,
      [intent.orderId],
    );
    const remaining = amount(intent.amountInRaw) - BigInt(prior.rows[0]!.spent);
    const input = (remaining * BigInt(model.partialFillBps)) / 10000n;
    if (input <= 0n) throw new Error('PARTIAL_AMOUNT_TOO_SMALL');
    const { rows } = await db.query<AttemptRow>(
      `INSERT INTO paper_execution_attempts(order_id,idempotency_key,sequence,input_raw,seed,model,draws,started_at_ms,ready_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        intent.orderId,
        key,
        prior.rows[0]!.sequence + 1,
        input.toString(),
        seed,
        JSON.stringify(model),
        JSON.stringify(draws),
        now,
        now + draws.latencyMs,
      ],
    );
    await recordAudit(db, {
      actor: 'system',
      action: 'paper.attempt_prepared',
      entityType: 'order',
      entityId: intent.orderId,
      details: {
        attemptId: rows[0]!.id,
        modelVersion: model.version,
        costsProvenance: model.fees.provenance,
      },
    });
    return toAttempt(rows[0]!);
  });
}
export async function loadPaperQuote(
  db: Queryable,
  id: string,
): Promise<QuoteEvidence | undefined> {
  return (
    await db.query<{ evidence: QuoteEvidence }>(
      'SELECT evidence FROM paper_execution_quotes WHERE attempt_id=$1',
      [id],
    )
  ).rows[0]?.evidence;
}
export async function savePaperQuote(
  db: Queryable,
  id: string,
  evidence: QuoteEvidence,
): Promise<QuoteEvidence> {
  await db.query(
    'INSERT INTO paper_execution_quotes(attempt_id,evidence) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [id, JSON.stringify(evidence)],
  );
  return (await loadPaperQuote(db, id))!;
}
export async function inspectPaperOrder(db: Queryable, id: string): Promise<ExecutionResult[]> {
  return (
    await db.query<{ result: ExecutionResult }>(
      'SELECT r.result FROM paper_execution_results r JOIN paper_execution_attempts a ON a.id=r.attempt_id WHERE r.order_id=$1 ORDER BY a.sequence',
      [id],
    )
  ).rows.map((r) => r.result);
}
export async function cancelPaperOrder(pool: Pool, id: string): Promise<void> {
  await withTransaction(pool, async (db) => {
    const order = await lockedPaperOrder(db, id);
    await loadPaperIntent(db, id);
    if (order.mode !== 'paper' || order.bot_mode !== 'paper') throw new Error('MODE_MISMATCH');
    if (['pending', 'partially_filled'].includes(order.status)) {
      await db.query("UPDATE orders SET status='cancelled' WHERE id=$1", [id]);
      await recordAudit(db, {
        actor: 'owner',
        action: 'paper.cancelled',
        entityType: 'order',
        entityId: id,
      });
    }
  });
}

/** Finalize under the SAME order/bankroll/position transaction. No pending holds to leak. */
export async function settlePaperAttempt(
  pool: Pool,
  attempt: PaperAttempt,
  candidate: ExecutionResult,
  executionClock: () => number = Date.now,
  executionStillFresh: () => boolean = () => true,
): Promise<ExecutionResult> {
  return withTransaction(pool, async (db) => {
    if (!/^[A-Z0-9_]{1,80}$/.test(candidate.reason)) throw new Error('INVALID_RESULT_REASON');
    const order = await lockedPaperOrder(db, attempt.orderId);
    const intent = await loadPaperIntent(db, attempt.orderId);
    matches(order, intent, false);
    const previous = (
      await db.query<{ result: ExecutionResult }>(
        'SELECT result FROM paper_execution_results WHERE attempt_id=$1',
        [attempt.id],
      )
    ).rows[0];
    if (previous) return previous.result;
    // The attempt, model, input and quote are durable, not caller overwriteable.
    const stored = (
      await db.query<AttemptRow>('SELECT * FROM paper_execution_attempts WHERE id=$1', [attempt.id])
    ).rows[0];
    if (
      !stored ||
      canonical(toAttempt(stored)) !== canonical(attempt) ||
      candidate.attemptId !== attempt.id ||
      candidate.orderId !== order.id
    )
      throw new Error('ATTEMPT_MISMATCH');
    interface Position {
      id: string;
      bot_id: string;
      token_mint: string;
      mode: string;
      status: string;
      quantity_raw: string;
      remaining_raw: string;
      cost_lamports: string;
    }
    const createdPositionId = (
      await db.query<{ position_id: string }>(
        'SELECT position_id FROM paper_execution_positions WHERE order_id=$1',
        [order.id],
      )
    ).rows[0]?.position_id;
    const targetPositionId = intent.positionId ?? createdPositionId;
    const pos = (
      await db.query<Position>(
        targetPositionId
          ? 'SELECT * FROM positions WHERE id=$1 FOR UPDATE'
          : "SELECT * FROM positions WHERE bot_id=$1 AND token_mint=$2 AND status='open' FOR UPDATE",
        targetPositionId ? [targetPositionId] : [intent.botId, intent.tokenMint],
      )
    ).rows[0];
    // Time must be sampled AFTER every potentially blocking order/bot/position lock.
    const now = integer(executionClock(), 1, Number.MAX_SAFE_INTEGER);
    const evidence = await loadPaperQuote(db, attempt.id);
    const toZero = (
      reason: string,
      status: ExecutionResult['status'] = 'failed',
    ): ExecutionResult => ({
      ...candidate,
      status,
      reason,
      inputRaw: '0',
      outputRaw: '0',
      networkFeeLamports: '0',
      priorityFeeLamports: '0',
    });
    if (order.bot_mode !== 'paper' || !(await exitAuthorityValid(db, intent)))
      candidate = toZero('EXIT_AUTHORITY_OR_MODE_REVOKED', 'cancelled');
    else if (order.status === 'cancelled') candidate = toZero('CANCELLED', 'cancelled');
    else if (now >= intent.expiresAt) candidate = toZero('INTENT_EXPIRED');
    else if (!executionStillFresh()) candidate = toZero('MONOTONIC_DEADLINE_EXPIRED');
    else if (now < attempt.startedAt) candidate = toZero('CLOCK_MOVED_BACKWARD');
    else if (now < attempt.readyAt) throw new Error('LATENCY_NOT_ELAPSED');
    else if (evidence?.status === 'available') {
      const q = evidence.quote;
      if (
        now >= q.expiresAt ||
        now < q.requestStartedAt ||
        now < q.receivedAt ||
        (q.contextBlockTimeMs !== null &&
          (q.contextBlockTimeMs > now ||
            now - q.contextBlockTimeMs > intent.quoteRequirements.maxAgeMs))
      )
        candidate = toZero('QUOTE_EXPIRED_OR_CHAIN_CONTEXT_UNAVAILABLE');
    }

    if (intent.side === 'buy' && pos) {
      if (await exitBuyIsFenced(db, intent))
        candidate = toZero('POSITION_EXIT_FROZEN', 'cancelled');
    }
    const fillCandidate = ['filled', 'partial'].includes(candidate.status);
    const submittedFailure =
      candidate.status === 'failed' && candidate.reason === 'SIMULATED_SUBMITTED_FAILURE';
    if (fillCandidate || submittedFailure) {
      if (
        !evidence ||
        evidence.status !== 'available' ||
        intent.quoteRequirements.fullyObservedCosts ||
        candidate.costsProvenance !== 'MODEL' ||
        candidate.networkFeeLamports !== attempt.model.fees.networkLamports ||
        candidate.priorityFeeLamports !== attempt.model.fees.priorityLamports
      )
        throw new Error('RESULT_EVIDENCE_MISMATCH');
      const simulatedFailure =
        attempt.draws.failurePpm < Math.floor(attempt.model.failureProbability * 1_000_000);
      if (
        (fillCandidate && simulatedFailure) ||
        (submittedFailure && (!simulatedFailure || attempt.model.failureStage !== 'submitted'))
      )
        throw new Error('RESULT_DRAW_MISMATCH');
      const q = evidence.quote;
      if (
        now >= q.expiresAt ||
        (q.contextBlockTimeMs !== null &&
          now - q.contextBlockTimeMs > intent.quoteRequirements.maxAgeMs) ||
        now < q.requestStartedAt ||
        now < q.receivedAt ||
        (q.freshnessBasis === 'bounded_request_age_MODEL' &&
          now - q.requestStartedAt > Math.min(5000, intent.quoteRequirements.maxAgeMs)) ||
        q.inputRaw !== attempt.inputRaw
      )
        throw new Error('RESULT_EVIDENCE_EXPIRED');
      if (
        fillCandidate &&
        (candidate.outputRaw !==
          (
            (BigInt(q.outputRaw) * BigInt(10000 - attempt.model.adverseSlippageBps)) /
            10000n
          ).toString() ||
          BigInt(candidate.outputRaw) < BigInt(q.minimumOutputRaw))
      )
        throw new Error('RESULT_OUTPUT_MISMATCH');
    } else if (
      candidate.networkFeeLamports !== '0' ||
      candidate.priorityFeeLamports !== '0' ||
      candidate.inputRaw !== '0' ||
      candidate.outputRaw !== '0'
    )
      throw new Error('RESULT_FEE_MISMATCH');
    let result = candidate;
    let fillId: string | null = null;
    const none = (
      reason: string,
      status: ExecutionResult['status'] = 'failed',
    ): ExecutionResult => ({
      ...candidate,
      status,
      reason,
      inputRaw: '0',
      outputRaw: '0',
      networkFeeLamports: '0',
      priorityFeeLamports: '0',
    });
    if (!['pending', 'partially_filled', 'cancelled'].includes(order.status))
      throw new Error('ORDER_NOT_EXECUTABLE');
    const fills = ['filled', 'partial'].includes(result.status);
    if (fills && (result.inputRaw !== attempt.inputRaw || amount(result.outputRaw) <= 0n))
      throw new Error('RESULT_MISMATCH');
    let fees = BigInt(result.networkFeeLamports) + BigInt(result.priorityFeeLamports);
    let input = fills ? BigInt(result.inputRaw) : 0n;
    let output = fills ? BigInt(result.outputRaw) : 0n;
    const requiredPrincipal =
      (fills || submittedFailure) && intent.side === 'buy' ? BigInt(attempt.inputRaw) : 0n;
    const spend = requiredPrincipal + fees;
    const posBad =
      pos &&
      (pos.bot_id !== intent.botId ||
        pos.token_mint !== intent.tokenMint ||
        pos.mode !== 'paper' ||
        pos.status !== 'open');
    if (
      (fills || submittedFailure) &&
      (posBad ||
        ((fills || submittedFailure) &&
          intent.side === 'sell' &&
          (!pos || BigInt(pos.remaining_raw) < BigInt(attempt.inputRaw))) ||
        BigInt(order.paper_bankroll_lamports) < spend ||
        (fills &&
          intent.side === 'buy' &&
          !intent.positionId &&
          pos &&
          createdPositionId !== pos.id))
    ) {
      result = none(
        posBad
          ? 'POSITION_MISMATCH'
          : BigInt(order.paper_bankroll_lamports) < spend
            ? 'INSUFFICIENT_PAPER_SOL'
            : 'INSUFFICIENT_OR_CONFLICTING_HOLDINGS',
      );
      input = 0n;
      output = 0n;
      fees = 0n;
    }
    if (fees > 0n || input > 0n || output > 0n)
      await db.query(
        'UPDATE bots SET paper_bankroll_lamports=paper_bankroll_lamports-$2::numeric+$3::numeric WHERE id=$1',
        [
          intent.botId,
          ((intent.side === 'buy' ? input : 0n) + fees).toString(),
          (intent.side === 'sell' ? output : 0n).toString(),
        ],
      );
    if (input > 0n) {
      const token = intent.side === 'buy' ? output : input;
      const sol = intent.side === 'buy' ? input : output;
      if (sol === 0n) throw new Error('ZERO_SOL_FILL');
      const priceNumerator = sol * 10n ** BigInt(order.decimals);
      const priceDenominator = token * 1_000_000_000n;
      // PostgreSQL numeric division preserves price precision; all cash/quantity math stays integer.
      const f = await db.query<{ id: string }>(
        `INSERT INTO fills(order_id,token_mint,mode,executed_at,token_amount_raw,sol_amount_lamports,price_sol,network_fee_lamports,priority_fee_lamports,slippage_bps,tx_signature) VALUES($1,$2,'paper',to_timestamp($3::double precision/1000),$4,$5,$6::numeric/$7::numeric,$8,$9,$10,NULL) RETURNING id`,
        [
          order.id,
          intent.tokenMint,
          now,
          token.toString(),
          sol.toString(),
          priceNumerator.toString(),
          priceDenominator.toString(),
          result.networkFeeLamports,
          result.priorityFeeLamports,
          attempt.model.adverseSlippageBps,
        ],
      );
      fillId = f.rows[0]!.id;
      if (intent.side === 'buy') {
        if (pos)
          await db.query(
            `UPDATE positions SET entry_price_sol=(cost_lamports+$2::numeric)*power(10::numeric,$4)/(remaining_raw+$3::numeric)/1000000000, high_water_price_sol=GREATEST(high_water_price_sol,$5::numeric/$6::numeric), quantity_raw=quantity_raw+$3::numeric,remaining_raw=remaining_raw+$3::numeric,cost_lamports=cost_lamports+$2::numeric WHERE id=$1`,
            [
              pos.id,
              (input + fees).toString(),
              output.toString(),
              order.decimals,
              priceNumerator.toString(),
              priceDenominator.toString(),
            ],
          );
        else {
          const created = await db.query<{ id: string }>(
            `INSERT INTO positions(bot_id,token_mint,mode,entry_price_sol,quantity_raw,remaining_raw,cost_lamports,stop_price_sol,high_water_price_sol,take_profit_remaining) VALUES($1,$2,'paper',$3::numeric/$4::numeric,$5,$5,$6,$7,$3::numeric/$4::numeric,$8) RETURNING id`,
            [
              intent.botId,
              intent.tokenMint,
              ((input + fees) * 10n ** BigInt(order.decimals)).toString(),
              priceDenominator.toString(),
              output.toString(),
              (input + fees).toString(),
              intent.entry!.stopPriceSol,
              JSON.stringify(intent.entry!.takeProfit),
            ],
          );
          await db.query(
            'INSERT INTO paper_execution_positions(order_id,position_id) VALUES($1,$2)',
            [order.id, created.rows[0]!.id],
          );
        }
      } else {
        const remaining = BigInt(pos!.remaining_raw) - input;
        // Cost basis removed proportionally, rounding UP conservatively for the realized PnL.
        const basis =
          (BigInt(pos!.cost_lamports) * input + BigInt(pos!.remaining_raw) - 1n) /
          BigInt(pos!.remaining_raw);
        await db.query(
          `UPDATE positions SET remaining_raw=$2,cost_lamports=cost_lamports-$3::numeric,realized_pnl_lamports=realized_pnl_lamports+$4::numeric,status=$5,closed_at=CASE WHEN $5='closed' THEN to_timestamp($6::double precision/1000) ELSE NULL END,close_reason=CASE WHEN $5='closed' THEN $7 ELSE NULL END WHERE id=$1`,
          [
            pos!.id,
            remaining.toString(),
            basis.toString(),
            (output - basis - fees).toString(),
            remaining === 0n ? 'closed' : 'open',
            now,
            intent.closeReason,
          ],
        );
      }
      const prior = await db.query<{ spent: string }>(
        "SELECT COALESCE(sum((result->>'inputRaw')::numeric),0)::text spent FROM paper_execution_results WHERE order_id=$1 AND result->>'status' IN ('filled','partial')",
        [order.id],
      );
      const complete = BigInt(prior.rows[0]!.spent) + input === BigInt(intent.amountInRaw);
      result = { ...result, status: complete ? 'filled' : 'partial' };
    }
    const status =
      result.status === 'partial'
        ? 'partially_filled'
        : result.status === 'unavailable'
          ? order.status
          : result.status;
    await db.query('UPDATE orders SET status=$2,failure_reason=$3 WHERE id=$1', [
      order.id,
      status,
      result.status === 'failed' ? result.reason : null,
    ]);
    await db.query(
      'INSERT INTO paper_execution_results(attempt_id,order_id,result,fill_id) VALUES($1,$2,$3,$4)',
      [attempt.id, order.id, JSON.stringify(result), fillId],
    );
    await recordAudit(db, {
      actor: 'system',
      action: 'paper.attempt_settled',
      entityType: 'order',
      entityId: order.id,
      details: {
        attemptId: attempt.id,
        status: result.status,
        reason: result.reason,
        inputRaw: result.inputRaw,
        outputRaw: result.outputRaw,
        networkFeeLamports: result.networkFeeLamports,
        priorityFeeLamports: result.priorityFeeLamports,
        costsProvenance: result.costsProvenance,
      },
    });
    return result;
  });
}
/** Clock and serialization come from PostgreSQL, not a possibly reset process clock. */
export async function reservePaperQuoteRequest(pool: Pool): Promise<void> {
  await withTransaction(pool, async (db) => {
    await db.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='2s'");
    await db.query('SELECT pg_advisory_xact_lock(4812270512)');
    const count = await db.query<{ n: string }>(
      "SELECT count(*)::text n FROM paper_execution_requests WHERE requested_at>clock_timestamp()-interval '60 seconds'",
    );
    if (BigInt(count.rows[0]!.n) >= 20n) throw new Error('QUOTE_RATE_LIMIT');
    const recent = await db.query(
      "SELECT 1 FROM paper_execution_requests WHERE requested_at>clock_timestamp()-interval '2 seconds' LIMIT 1",
    );
    if (recent.rows.length) throw new Error('QUOTE_RATE_LIMIT');
    await db.query(
      "DELETE FROM paper_execution_requests WHERE requested_at<clock_timestamp()-interval '10 minutes'",
    );
    await db.query('INSERT INTO paper_execution_requests DEFAULT VALUES');
  });
}

/** The immutable claim elects exactly one fetcher without retaining a pool connection.
 * A competing caller waits at most five seconds for saved evidence; an interrupted
 * or overlong acquisition becomes unavailable, never an implicit quote refresh. */
export async function acquirePaperQuote(
  pool: Pool,
  id: string,
  now: number,
  fetchQuote: () => Promise<QuoteEvidence>,
): Promise<QuoteEvidence> {
  integer(now, 1, Number.MAX_SAFE_INTEGER);
  const existing = await loadPaperQuote(pool, id);
  if (existing) return existing;
  // Each query finishes and releases its pooled client before any provider IO.
  const election = await pool.query(
    'INSERT INTO paper_execution_quote_claims(attempt_id,claimed_at_ms) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING attempt_id',
    [id, now],
  );
  if (election.rows.length) return savePaperQuote(pool, id, await fetchQuote());
  const claim = (
    await pool.query<{ claimed_at_ms: string }>(
      'SELECT claimed_at_ms FROM paper_execution_quote_claims WHERE attempt_id=$1',
      [id],
    )
  ).rows[0]!;
  const age = now - Number(claim.claimed_at_ms);
  const deadline = performance.now() + Math.max(0, 5000 - Math.max(0, age));
  while (true) {
    const saved = await loadPaperQuote(pool, id);
    if (saved) return saved;
    if (age < 0 || performance.now() >= deadline)
      return savePaperQuote(pool, id, {
        status: 'unavailable',
        reason: 'QUOTE_ACQUISITION_INTERRUPTED',
      });
    await delay(10);
  }
}

import { randomUUID } from 'node:crypto';
import type { ApprovedOrderIntent, ExecutionResult } from '@memebots/core';
import { recordAudit } from './audit.js';
import { withTransaction } from './pool.js';
import type { Pool, Queryable } from './pool.js';

export interface ExitPolicy {
  profileId: string;
  revision: string;
  stopPriceSol: string;
  takeProfit: { atGain: number; sellFraction: number }[];
  trailingFraction: string | null;
  maxHoldMinutes: number;
  maxSlippageBps: number;
  priceFeeAllowanceLamports: string;
  pricePolicy: string;
  quoteRequirements: ApprovedOrderIntent['quoteRequirements'];
}
export interface ExitPosition {
  id: string;
  bot_id: string;
  token_mint: string;
  mode: string;
  status: string;
  remaining_raw: string;
  quantity_raw: string;
  entry_price_sol: string;
  decimals: number;
  opened_at: Date;
  policy: ExitPolicy;
  generation: string;
}
export interface ExitObservation {
  /** Net token->SOL quote less the explicitly selected MODEL transaction fee allowance. */
  positionId: string;
  tokenMint: string;
  inputRaw: string;
  numerator: string;
  denominator: string;
  observedAt: number;
  expiresAt: number;
  provenance: unknown;
}
export function decimalRatio(value: string | number): [bigint, bigint] {
  const s = String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_EXIT_DECIMAL');
    const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error('INVALID_EXIT_DECIMAL');
    const scale = (m[2]?.length ?? 0) - Number(m[3] ?? 0);
    const n = BigInt(m[1]! + (m[2] ?? ''));
    return scale < 0 ? [n * 10n ** BigInt(-scale), 1n] : [n, 10n ** BigInt(scale)];
  }
  if (s.length > 128 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,30})?$/.test(s))
    throw new Error('INVALID_EXIT_DECIMAL');
  const [a, b = ''] = s.split('.');
  return [BigInt(a! + b), 10n ** BigInt(b.length)];
}
const cmp = (a: bigint, b: bigint, c: bigint, d: bigint) => a * d - c * b;
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v);
};
/** Authority is the immutable full intent receipt, never a caller supplied marker. */
export async function exitAuthorityValid(
  db: Queryable,
  intent: ApprovedOrderIntent,
): Promise<boolean> {
  if (intent.approval.kind !== 'exit_manager') return true;
  const row = (
    await db.query<{ intent: ApprovedOrderIntent; remaining_raw: string; spent: string }>(
      `SELECT d.intent,p.remaining_raw,COALESCE((SELECT sum((r.result->>'inputRaw')::numeric) FROM paper_execution_results r WHERE r.order_id=$1 AND r.result->>'status' IN ('filled','partial')),0)::text spent
     FROM position_exit_decisions d JOIN position_exit_state s ON s.active_decision=d.id
     JOIN positions p ON p.id=d.position_id JOIN bots b ON b.id=p.bot_id
     WHERE d.id::text=$2 AND p.id=$3 AND p.bot_id=$4 AND p.token_mint=$5 AND p.mode='paper' AND p.status='open' AND b.mode='paper'`,
      [
        intent.orderId,
        intent.approval.reference,
        intent.positionId,
        intent.botId,
        intent.tokenMint,
      ],
    )
  ).rows[0];
  return (
    !!row &&
    intent.side === 'sell' &&
    canonical(row.intent) === canonical(intent) &&
    BigInt(intent.amountInRaw) - BigInt(row.spent) <= BigInt(row.remaining_raw)
  );
}
/** Existing partial entry may finish until the first exit; a newly submitted scale-in may not. */
export async function exitBuyIsFenced(
  db: Queryable,
  intent: ApprovedOrderIntent,
): Promise<boolean> {
  if (intent.side !== 'buy') return false;
  return (
    (
      await db.query(
        `SELECT 1 FROM positions p JOIN position_exit_state s ON s.position_id=p.id JOIN orders o ON o.id=$3 WHERE p.bot_id=$1 AND p.token_mint=$2 AND p.status='open' AND (s.original_raw IS NOT NULL OR o.created_at>s.created_at)`,
        [intent.botId, intent.tokenMint, intent.orderId],
      )
    ).rows.length > 0
  );
}
interface State {
  original_raw: string | null;
  high_n: string;
  high_d: string;
  observed_at_ms: string;
  filled_steps: string[];
  dust_steps: number[];
  active_decision: string | null;
}
async function lockPosition(db: Queryable, id: string): Promise<ExitPosition | undefined> {
  const bot = (await db.query<{ bot_id: string }>('SELECT bot_id FROM positions WHERE id=$1', [id]))
    .rows[0];
  if (!bot) return;
  await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [bot.bot_id]);
  // Stable order locks precede position locks, including unfinished entry orders.
  await db.query(
    'SELECT id FROM orders WHERE bot_id=$1 AND (position_id=$2 OR id IN (SELECT order_id FROM paper_execution_positions WHERE position_id=$2)) ORDER BY id FOR UPDATE',
    [bot.bot_id, id],
  );
  return (
    await db.query<ExitPosition>(
      `SELECT p.*,t.decimals,e.policy FROM positions p JOIN bots b ON b.id=p.bot_id JOIN tokens t ON t.mint=p.token_mint JOIN position_exit_policies e ON e.position_id=p.id WHERE p.id=$1 AND b.mode='paper' AND p.mode='paper' AND p.status='open' FOR UPDATE OF p`,
      [id],
    )
  ).rows[0];
}
export async function claimExitPosition(
  pool: Pool,
  id: string,
  owner: string,
): Promise<ExitPosition | undefined> {
  return withTransaction(pool, async (db) => {
    const p = await lockPosition(db, id);
    if (!p) return;
    await db.query(
      'INSERT INTO position_exit_state(position_id) VALUES($1) ON CONFLICT DO NOTHING',
      [id],
    );
    const claimed = await db.query<{ lease_generation: string }>(
      `UPDATE position_exit_state SET lease_owner=$2,lease_generation=lease_generation+1,lease_until=clock_timestamp()+interval '15 seconds',last_checked_at=clock_timestamp() WHERE position_id=$1 AND retry_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING lease_generation::text`,
      [id, owner],
    );
    if (!claimed.rows[0]) return;
    return { ...p, generation: claimed.rows[0].lease_generation };
  });
}
/** One view derivation for both successful fills and explicit zero-unit completions. */
function remainingTakeProfit(p: ExitPosition, s: State): ExitPolicy['takeProfit'] {
  return p.policy.takeProfit.filter((step, i) => {
    const [n, d] = decimalRatio(step.sellFraction);
    const desired = (BigInt(s.original_raw ?? p.quantity_raw) * n) / d;
    return !s.dust_steps.includes(i) && desired > BigInt(s.filled_steps[i] ?? '0');
  });
}
async function persistRemainingTakeProfit(db: Queryable, p: ExitPosition, s: State): Promise<void> {
  await db.query(
    "UPDATE positions SET take_profit_remaining=CASE WHEN status='closed' THEN '[]'::jsonb ELSE $2::jsonb END WHERE id=$1",
    [p.id, JSON.stringify(remainingTakeProfit(p, s))],
  );
}
async function reconcile(db: Queryable, p: ExitPosition, s: State): Promise<void> {
  const rows = (
    await db.query<{
      attempt_id: string;
      id: string;
      allocations: { step: number; raw: string }[];
      result: ExecutionResult;
    }>(
      `SELECT r.attempt_id,d.id,d.allocations,r.result FROM position_exit_decisions d JOIN paper_execution_results r ON r.order_id=(d.intent->>'orderId')::uuid LEFT JOIN position_exit_fill_receipts f ON f.attempt_id=r.attempt_id WHERE d.position_id=$1 AND f.attempt_id IS NULL AND r.result->>'status' IN ('filled','partial') ORDER BY r.created_at,r.attempt_id`,
      [p.id],
    )
  ).rows;
  if (!rows.length) return;
  const filled = p.policy.takeProfit.map((_, i) => BigInt(s.filled_steps[i] ?? '0'));
  for (const row of rows) {
    let units = BigInt(row.result.inputRaw);
    // Earlier fills on this decision consume its fixed allocation in step order.
    const prior = await db.query<{ n: string }>(
      'SELECT COALESCE(sum(input_raw),0)::text n FROM position_exit_fill_receipts WHERE decision_id=$1',
      [row.id],
    );
    let skip = BigInt(prior.rows[0]!.n);
    for (const allocation of row.allocations) {
      const size = BigInt(allocation.raw);
      const skipped = skip > size ? size : skip;
      skip -= skipped;
      const available = size - skipped;
      const used = units > available ? available : units;
      filled[allocation.step] = (filled[allocation.step] ?? 0n) + used;
      units -= used;
    }
    await db.query(
      'INSERT INTO position_exit_fill_receipts(attempt_id,decision_id,input_raw) VALUES($1,$2,$3)',
      [row.attempt_id, row.id, row.result.inputRaw],
    );
    await recordAudit(db, {
      actor: 'system',
      action: 'exit.fill_progress',
      entityType: 'position',
      entityId: p.id,
      details: { decisionId: row.id, inputRaw: row.result.inputRaw },
    });
  }
  s.filled_steps = filled.map(String);
  await persistRemainingTakeProfit(db, p, s);
  await db.query('UPDATE position_exit_state SET filled_steps=$2 WHERE position_id=$1', [
    p.id,
    JSON.stringify(s.filled_steps),
  ]);
}
/** Commit a decision before any executor/provider call; transaction uses only its supplied client. */
export async function decidePositionExit(
  pool: Pool,
  claimed: ExitPosition,
  owner: string,
  observation?: ExitObservation,
): Promise<ApprovedOrderIntent | undefined> {
  return withTransaction(pool, async (db) => {
    const p = await lockPosition(db, claimed.id);
    if (!p) return;
    const fence = await db.query(
      `SELECT 1 FROM position_exit_state WHERE position_id=$1 AND lease_owner=$2 AND lease_generation=$3 AND lease_until>clock_timestamp() FOR UPDATE`,
      [p.id, owner, claimed.generation],
    );
    if (!fence.rows.length) return;
    const s = (
      await db.query<State>('SELECT * FROM position_exit_state WHERE position_id=$1', [p.id])
    ).rows[0]!;
    await reconcile(db, p, s);
    const now = Number(
      (
        await db.query<{ ms: string }>(
          'SELECT floor(extract(epoch from clock_timestamp())*1000)::text ms',
        )
      ).rows[0]!.ms,
    );
    let mark: [bigint, bigint] | undefined;
    if (
      observation &&
      observation.positionId === p.id &&
      observation.tokenMint === p.token_mint &&
      observation.inputRaw === p.remaining_raw &&
      /^(0|[1-9][0-9]{0,79})$/.test(observation.numerator) &&
      /^[1-9][0-9]{0,79}$/.test(observation.denominator) &&
      Number.isSafeInteger(observation.expiresAt) &&
      observation.expiresAt <= observation.observedAt + p.policy.quoteRequirements.maxAgeMs &&
      Number.isSafeInteger(observation.observedAt) &&
      observation.observedAt > Number(s.observed_at_ms) &&
      observation.observedAt <= now &&
      observation.expiresAt > now &&
      now - observation.observedAt <= p.policy.quoteRequirements.maxAgeMs
    ) {
      const n = BigInt(observation.numerator),
        d = BigInt(observation.denominator);
      if (n >= 0n && d > 0n) {
        mark = [n, d];
        await db.query(
          'INSERT INTO position_exit_observations(position_id,observed_at_ms,evidence) VALUES($1,$2,$3)',
          [p.id, observation.observedAt, JSON.stringify(observation)],
        );
        if (cmp(n, d, BigInt(s.high_n), BigInt(s.high_d)) > 0n) {
          s.high_n = n.toString();
          s.high_d = d.toString();
        }
        await db.query(
          'UPDATE position_exit_state SET high_n=$2,high_d=$3,observed_at_ms=$4 WHERE position_id=$1',
          [p.id, s.high_n, s.high_d, observation.observedAt],
        );
        await db.query(
          'UPDATE positions SET high_water_price_sol=GREATEST(high_water_price_sol,$2::numeric/$3::numeric) WHERE id=$1',
          [p.id, s.high_n, s.high_d],
        );
      }
    }
    let reason: ApprovedOrderIntent['closeReason'] = null;
    if (mark) {
      const [sn, sd] = decimalRatio(p.policy.stopPriceSol);
      if (cmp(...mark, sn, sd) <= 0n) reason = 'stop_loss';
      else if (p.policy.trailingFraction !== null) {
        const [tn, td] = decimalRatio(p.policy.trailingFraction);
        if (cmp(...mark, BigInt(s.high_n) * (td - tn), BigInt(s.high_d) * td) <= 0n)
          reason = 'trailing_stop';
      }
    }
    if (!reason && now - p.opened_at.getTime() >= p.policy.maxHoldMinutes * 60000)
      reason = 'time_stop';
    const protective = reason !== null;
    let allocations: { step: number; raw: string }[] = [];
    let crossedTP = false;
    const dust: number[] = [];
    if (!reason && mark) {
      const [en, ed] = decimalRatio(p.entry_price_sol);
      p.policy.takeProfit.forEach((step, i) => {
        const [gn, gd] = decimalRatio(step.atGain);
        if (cmp(...mark!, en * (gd + gn), ed * gd) >= 0n) {
          crossedTP = true;
          const [fn, fd] = decimalRatio(step.sellFraction);
          const desired = (BigInt(s.original_raw ?? p.quantity_raw) * fn) / fd;
          const left = desired - BigInt(s.filled_steps[i] ?? '0');
          if (desired === 0n && !s.dust_steps.includes(i)) dust.push(i);
          if (left > 0n) allocations.push({ step: i, raw: left.toString() });
        }
      });
      if (allocations.length) reason = 'take_profit';
    }
    if (s.active_decision) {
      const active = (
        await db.query<{
          intent: ApprovedOrderIntent;
          status: string;
          allocations: { step: number; raw: string }[];
        }>(
          `SELECT d.intent,d.allocations,o.status FROM position_exit_decisions d JOIN orders o ON o.id=(d.intent->>'orderId')::uuid WHERE d.id=$1`,
          [s.active_decision],
        )
      ).rows[0]!;
      const usable =
        ['pending', 'partially_filled'].includes(active.status) && active.intent.expiresAt > now;
      if (usable && (!protective || active.intent.closeReason !== 'take_profit'))
        return active.intent;
      if (!protective && active.intent.closeReason !== 'take_profit') {
        reason = active.intent.closeReason;
        allocations = [];
      }
      if (!reason) {
        reason = active.intent.closeReason;
        const paid = (
          await db.query<{ n: string }>(
            'SELECT COALESCE(sum(input_raw),0)::text n FROM position_exit_fill_receipts WHERE decision_id=$1',
            [s.active_decision],
          )
        ).rows[0]!.n;
        let skip = BigInt(paid);
        allocations = active.allocations.flatMap((a) => {
          const raw = BigInt(a.raw);
          const used = skip > raw ? raw : skip;
          skip -= used;
          return raw > used ? [{ step: a.step, raw: (raw - used).toString() }] : [];
        });
      }
      if (usable || ['pending', 'partially_filled'].includes(active.status))
        await db.query("UPDATE orders SET status='cancelled' WHERE id=$1", [active.intent.orderId]);
      await db.query('UPDATE position_exit_state SET active_decision=NULL WHERE position_id=$1', [
        p.id,
      ]);
    }
    if (!reason && !crossedTP) return;
    // Entry settlements use the same bot lock, so they commit before this freeze or observe cancellation.
    await db.query(
      `UPDATE orders SET status='cancelled' WHERE bot_id=$1 AND side='buy' AND status IN ('pending','partially_filled') AND (position_id=$2 OR id IN (SELECT order_id FROM paper_execution_positions WHERE position_id=$2))`,
      [p.bot_id, p.id],
    );
    if (!s.original_raw) {
      s.original_raw = p.quantity_raw;
      await db.query('UPDATE position_exit_state SET original_raw=$2 WHERE position_id=$1', [
        p.id,
        s.original_raw,
      ]);
    }
    for (const step of dust)
      await recordAudit(db, {
        actor: 'system',
        action: 'exit.tp_dust',
        entityType: 'position',
        entityId: p.id,
        details: { step, reason: 'ZERO_ORIGINAL_ALLOCATION', originalRaw: s.original_raw },
      });
    if (dust.length) {
      s.dust_steps = [...s.dust_steps, ...dust];
      await db.query('UPDATE position_exit_state SET dust_steps=$2 WHERE position_id=$1', [
        p.id,
        JSON.stringify(s.dust_steps),
      ]);
      await persistRemainingTakeProfit(db, p, s);
    }
    if (!reason) return;
    let units =
      reason === 'take_profit'
        ? allocations.reduce((a, x) => a + BigInt(x.raw), 0n)
        : BigInt(p.remaining_raw);
    if (units > BigInt(p.remaining_raw)) units = BigInt(p.remaining_raw);
    if (units <= 0n) return;
    if (reason !== 'take_profit') allocations = [];
    const sequence = (
      await db.query<{ n: number }>(
        'SELECT COALESCE(max(sequence),0)+1 n FROM position_exit_decisions WHERE position_id=$1',
        [p.id],
      )
    ).rows[0]!.n;
    const id = randomUUID();
    const intent: ApprovedOrderIntent = {
      orderId: id,
      clientOrderId: `exit:${p.id}:${sequence}`,
      botId: p.bot_id,
      positionId: p.id,
      tokenMint: p.token_mint,
      side: 'sell',
      mode: 'paper',
      amountInRaw: units.toString(),
      maxSlippageBps: p.policy.maxSlippageBps,
      expiresAt: now + 60000,
      approval: { kind: 'exit_manager', reference: id },
      quoteRequirements: p.policy.quoteRequirements,
      entry: null,
      closeReason: reason,
    };
    await db.query(
      `INSERT INTO orders(id,client_order_id,bot_id,position_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,$5,'sell','paper',$6,$7,$8)`,
      [
        id,
        intent.clientOrderId,
        p.bot_id,
        p.id,
        p.token_mint,
        intent.amountInRaw,
        intent.maxSlippageBps,
        reason,
      ],
    );
    await db.query(
      'INSERT INTO position_exit_decisions(id,position_id,sequence,intent,allocations,evidence) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        p.id,
        sequence,
        JSON.stringify(intent),
        JSON.stringify(allocations),
        observation ? JSON.stringify(observation) : null,
      ],
    );
    await db.query('INSERT INTO paper_execution_intents(order_id,intent) VALUES($1,$2)', [
      id,
      JSON.stringify(intent),
    ]);
    await db.query('UPDATE position_exit_state SET active_decision=$2 WHERE position_id=$1', [
      p.id,
      id,
    ]);
    await recordAudit(db, {
      actor: 'system',
      action: 'exit.decision',
      entityType: 'position',
      entityId: p.id,
      details: {
        decisionId: id,
        reason,
        amountInRaw: intent.amountInRaw,
        originalRaw: s.original_raw,
      },
    });
    return intent;
  });
}
/** Stable interrupted-attempt recovery; a completed unavailable attempt gets a new bounded retry. */
export async function exitAttemptKey(db: Queryable, orderId: string): Promise<string> {
  const rows = (
    await db.query<{ idempotency_key: string; finished: boolean; sequence: number }>(
      `SELECT a.idempotency_key,a.sequence,r.attempt_id IS NOT NULL finished FROM paper_execution_attempts a LEFT JOIN paper_execution_results r ON r.attempt_id=a.id WHERE a.order_id=$1 ORDER BY sequence DESC LIMIT 1`,
      [orderId],
    )
  ).rows;
  return rows[0] && !rows[0].finished
    ? rows[0].idempotency_key
    : `exit:${orderId}:${(rows[0]?.sequence ?? 0) + 1}`;
}
export async function releaseExitLease(
  pool: Pool,
  p: ExitPosition,
  owner: string,
  result?: ExecutionResult,
): Promise<void> {
  await withTransaction(pool, async (db) => {
    const locked = await lockPosition(db, p.id);
    // Closed positions still need their final fill receipt reconciled.
    const s = (
      await db.query<State>('SELECT * FROM position_exit_state WHERE position_id=$1', [p.id])
    ).rows[0];
    if (s) await reconcile(db, locked ?? p, s);
    await db.query(
      `UPDATE position_exit_state SET lease_until=NULL,retry_count=CASE WHEN $4 THEN LEAST(6,retry_count+1) ELSE 0 END,retry_at=clock_timestamp()+make_interval(secs=>CASE WHEN $4 THEN LEAST(60,power(2,LEAST(6,retry_count+1)))::integer ELSE 2 END) WHERE position_id=$1 AND lease_owner=$2 AND lease_generation=$3`,
      [p.id, owner, p.generation, !!result && !['filled', 'partial'].includes(result.status)],
    );
    if (result && !['filled', 'partial'].includes(result.status))
      await recordAudit(db, {
        actor: 'system',
        action: 'exit.retry_required',
        entityType: 'position',
        entityId: p.id,
        details: { status: result.status, reason: result.reason },
      });
  });
}
export async function inspectPositionExit(db: Queryable, id: string): Promise<unknown> {
  return {
    policy: (await db.query('SELECT * FROM position_exit_policies WHERE position_id=$1', [id]))
      .rows[0],
    state: (await db.query('SELECT * FROM position_exit_state WHERE position_id=$1', [id])).rows[0],
    decisions: (
      await db.query(
        'SELECT * FROM position_exit_decisions WHERE position_id=$1 ORDER BY sequence',
        [id],
      )
    ).rows,
  };
}

/** Closed/off positions also need exactly-once receipt recovery after a process dies after settlement. */
export async function reconcileExitFills(pool: Pool, limit = 100): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_EXIT_LIMIT');
  const ids = (
    await pool.query<{ position_id: string }>(
      `SELECT DISTINCT d.position_id FROM position_exit_decisions d JOIN paper_execution_results r ON r.order_id=(d.intent->>'orderId')::uuid LEFT JOIN position_exit_fill_receipts f ON f.attempt_id=r.attempt_id WHERE f.attempt_id IS NULL AND r.result->>'status' IN ('filled','partial') LIMIT $1`,
      [limit],
    )
  ).rows;
  for (const row of ids)
    await withTransaction(pool, async (db) => {
      await lockPosition(db, row.position_id);
      const p = (
        await db.query<ExitPosition>(
          'SELECT p.*,e.policy FROM positions p JOIN position_exit_policies e ON e.position_id=p.id WHERE p.id=$1 FOR UPDATE OF p',
          [row.position_id],
        )
      ).rows[0];
      const state = (
        await db.query<State>('SELECT * FROM position_exit_state WHERE position_id=$1 FOR UPDATE', [
          row.position_id,
        ])
      ).rows[0];
      if (p && state) await reconcile(db, p, state);
    });
}

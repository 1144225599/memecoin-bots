import { randomUUID } from 'node:crypto';
import type { ApprovedOrderIntent, ExecutionResult, PaperModel } from '@memebots/core';
import {
  claimExitPosition,
  decidePositionExit,
  exitAttemptKey,
  releaseExitLease,
  reconcileExitFills,
} from '@memebots/db';
import type { Pool, ExitPosition, ExitObservation } from '@memebots/db';
import { PaperBroker } from '../paper/broker.js';
import { quoteIsFresh, validateExecutableQuote } from '../paper/quote.js';
import type { PaperQuoteProvider } from '../paper/quote.js';

/** Explicit paper-v1 fee/latency scenario; no observed network-fee claim. */
export const EXIT_PAPER_MODEL: PaperModel = Object.freeze({
  version: 'paper-v1',
  minLatencyMs: 0,
  maxLatencyMs: 0,
  adverseSlippageBps: 0,
  failureProbability: 0,
  failureStage: 'submitted',
  partialFillBps: 10000,
  fees: {
    provenance: 'MODEL' as const,
    selectedBy: 'exit-paper-v1',
    networkLamports: '5000',
    priorityLamports: '0',
  },
});
export interface ExitOutcome {
  positionId: string;
  orderId?: string;
  result?: ExecutionResult;
  code: string;
}
export class PositionExitManager {
  private readonly owner = randomUUID();
  private readonly broker: PaperBroker;
  constructor(
    private readonly pool: Pool,
    private readonly provider: PaperQuoteProvider,
    private readonly options: {
      model?: PaperModel;
      signal?: AbortSignal;
      clock?: () => number;
    } = {},
  ) {
    this.broker = new PaperBroker(pool, provider, options.model ?? EXIT_PAPER_MODEL, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }
  /** Single bounded round, with oldest positions interleaved fairly across bots. */
  async once(options: { botId?: string; limit?: number } = {}): Promise<ExitOutcome[]> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_EXIT_LIMIT');
    await reconcileExitFills(this.pool, limit);
    const rows = (
      await this.pool.query<{ id: string }>(
        `SELECT id FROM (SELECT p.id,p.opened_at,COALESCE(s.last_checked_at,'epoch'::timestamptz) checked,row_number() OVER(PARTITION BY p.bot_id ORDER BY COALESCE(s.last_checked_at,'epoch'::timestamptz),p.opened_at,p.id) turn FROM positions p JOIN bots b ON b.id=p.bot_id LEFT JOIN position_exit_state s ON s.position_id=p.id WHERE p.status='open' AND p.mode='paper' AND b.mode='paper' AND (s.retry_at IS NULL OR s.retry_at<=clock_timestamp()) AND (s.lease_until IS NULL OR s.lease_until<clock_timestamp()) AND ($1::uuid IS NULL OR p.bot_id=$1)) eligible ORDER BY turn,checked,opened_at,id LIMIT $2`,
        [options.botId ?? null, limit],
      )
    ).rows;
    const outcomes: ExitOutcome[] = [];
    // Sequential IO respects shared free-provider budget; concurrency belongs to durable leases.
    for (const row of rows) {
      this.options.signal?.throwIfAborted();
      outcomes.push(await this.process(row.id));
    }
    return outcomes;
  }
  private async mark(p: ExitPosition): Promise<ExitObservation | undefined> {
    const now = (this.options.clock ?? Date.now)();
    const intent: ApprovedOrderIntent = {
      orderId: randomUUID(),
      clientOrderId: `exit-mark:${p.id}`,
      botId: p.bot_id,
      positionId: p.id,
      tokenMint: p.token_mint,
      side: 'sell',
      mode: 'paper',
      amountInRaw: p.remaining_raw,
      maxSlippageBps: p.policy.maxSlippageBps,
      expiresAt: now + 5000,
      approval: { kind: 'exit_manager', reference: 'mark-only' },
      quoteRequirements: p.policy.quoteRequirements,
      entry: null,
      closeReason: 'manual',
    };
    const evidence = await this.provider.quote({ intent, inputRaw: p.remaining_raw });
    if (evidence.status !== 'available') return;
    validateExecutableQuote(evidence.quote, { intent, inputRaw: p.remaining_raw });
    const current =
      evidence.quote.freshnessBasis === 'chain_context'
        ? await this.provider.currentContext()
        : undefined;
    if (!quoteIsFresh(evidence.quote, intent, current, (this.options.clock ?? Date.now)())) return;
    // A fixed, explicitly MODEL allowance is stored with each policy, independent of a caller's model.
    const afterFees = BigInt(evidence.quote.outputRaw) - BigInt(p.policy.priceFeeAllowanceLamports);
    // A valid deeply adverse quote remains a protective mark even if fees consume its proceeds.
    const net = afterFees > 0n ? afterFees : 0n;
    return {
      positionId: p.id,
      tokenMint: p.token_mint,
      inputRaw: p.remaining_raw,
      numerator: (net * 10n ** BigInt(p.decimals)).toString(),
      denominator: (BigInt(p.remaining_raw) * 1000000000n).toString(),
      observedAt: evidence.quote.requestStartedAt,
      expiresAt: evidence.quote.expiresAt,
      provenance: {
        quote: evidence.quote,
        pricePolicy: p.policy.pricePolicy,
        priceFeeAllowanceLamports: p.policy.priceFeeAllowanceLamports,
      },
    };
  }
  async process(id: string): Promise<ExitOutcome> {
    const p = await claimExitPosition(this.pool, id, this.owner);
    if (!p) return { positionId: id, code: 'INELIGIBLE_OR_LEASED' };
    let result: ExecutionResult | undefined;
    try {
      let observation: ExitObservation | undefined;
      try {
        observation = await this.mark(p);
      } catch {
        /* Invalid/unavailable price cannot manufacture a trigger. */
      }
      const intent = await decidePositionExit(this.pool, p, this.owner, observation);
      if (!intent)
        return { positionId: id, code: observation ? 'NO_TRIGGER' : 'PRICE_UNAVAILABLE' };
      result = await this.broker.execute(intent, await exitAttemptKey(this.pool, intent.orderId));
      return { positionId: id, orderId: intent.orderId, result, code: 'EXECUTION_RECORDED' };
    } catch {
      return { positionId: id, code: 'EXIT_PROCESS_FAILED_RETRY_REQUIRED' };
    } finally {
      await releaseExitLease(this.pool, p, this.owner, result);
    }
  }
}

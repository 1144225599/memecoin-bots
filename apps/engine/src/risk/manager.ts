import { randomUUID } from 'node:crypto';
import {
  decimalRatio,
  fractionFloor,
  isProfileObject,
  netRewardRisk,
  validateModel,
  validateRiskProfile,
  validateSignal,
  PAPER_SOL_MINT,
  ceilDiv,
} from '@memebots/core';
import type {
  ApprovedOrderIntent,
  OpportunityTarget,
  PaperModel,
  RiskDecision,
  RiskLiquidity,
  RiskProfile,
  Signal,
  ExecutableQuote,
} from '@memebots/core';
import {
  ensureRiskDay,
  getRiskProfile,
  reconcileRiskAdmissions,
  recordAudit,
  registerPaperIntentInTransaction,
  riskCanonical,
  riskConfigHash,
  riskExposure,
  riskHash,
  SafetyStore,
  withTransaction,
} from '@memebots/db';
import type { Pool } from '@memebots/db';
import { CHECKS, evaluate, validateEvidence, validatePolicy } from '../safety/evidence.js';
import type { Policy } from '../safety/evidence.js';
import type { PaperQuoteProvider } from '../paper/quote.js';
import { quoteIsFresh, validateExecutableQuote } from '../paper/quote.js';
import { PaperBroker } from '../paper/broker.js';

/** Reuse the immutable full-size admission quote, retaining its original age and
 * avoiding a second immediate provider rate-budget request. */
export function createRiskPaperBroker(
  pool: Pool,
  provider: PaperQuoteProvider,
  model: PaperModel,
): PaperBroker {
  return new PaperBroker(
    pool,
    {
      currentContext: () => provider.currentContext(),
      quote: async (request) => {
        if (request.intent.approval.kind === 'risk_manager') {
          const saved = (
            await pool.query<{
              principal_lamports: string;
              assumptions: { entryQuote: ExecutableQuote };
            }>('SELECT principal_lamports,assumptions FROM risk_admissions WHERE order_id=$1', [
              request.intent.orderId,
            ])
          ).rows[0];
          if (saved && saved.principal_lamports === request.inputRaw)
            return { status: 'available', quote: saved.assumptions.entryQuote };
        }
        return provider.quote(request);
      },
    },
    model,
  );
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ATTEMPTS = 3;
interface Bot {
  id: string;
  strategy: string;
  strategy_params: unknown;
  risk_profile_id: string;
  mode: string;
  paper_bankroll_lamports: string;
  wallet_id: string;
}
class Veto extends Error {
  constructor(
    code: string,
    readonly metrics: Record<string, string | number> = {},
  ) {
    super(code);
  }
}
function deny(code: string, metrics: Record<string, string | number> = {}): never {
  throw new Veto(code, metrics);
}
export function profileSafetyPolicy(
  profile: Pick<RiskProfile, 'safetyMode' | 'minSafetyScore'>,
): Policy {
  const limits = {
    strict: [500, 100, 15000],
    standard: [1000, 500, 30000],
    relaxed: [2000, 1000, 60000],
  }[profile.safetyMode];
  if (!limits) return deny('INVALID_PROFILE');
  return validatePolicy({
    version: 'engineering_v1',
    minScore: profile.minSafetyScore,
    maxOwnerBps: limits[0],
    maxDeveloperBps: limits[1],
    maxAgeMs: limits[2],
    refreshMs: limits[2],
    negativeCacheMs: 10000,
  });
}
function fresh(
  value: { observedAt: number; expiresAt: number; provenance: string },
  now: number,
): boolean {
  return (
    Number.isSafeInteger(value.observedAt) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.observedAt <= now &&
    now - value.observedAt <= 30000 &&
    value.expiresAt > now &&
    value.expiresAt <= value.observedAt + 60000 &&
    /^[a-zA-Z0-9_.:-]{1,80}$/.test(value.provenance)
  );
}
function signalValid(value: unknown): value is Signal {
  return (
    isProfileObject(value) &&
    Object.keys(value).every((k) =>
      ['token', 'side', 'confidence', 'reason', 'suggestedStopDistance'].includes(k),
    ) &&
    typeof value.token === 'string' &&
    MINT.test(value.token) &&
    value.token !== PAPER_SOL_MINT &&
    ['buy', 'sell'].includes(value.side as string) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    typeof value.reason === 'string' &&
    value.reason.length <= 500 &&
    (value.suggestedStopDistance === undefined ||
      typeof value.suggestedStopDistance === 'number') &&
    validateSignal(value as unknown as Signal).length === 0
  );
}
function profileConfig(profile: RiskProfile): Record<string, unknown> {
  const { id, revision, ...config } = profile;
  void id;
  void revision;
  return config;
}
export interface RiskOptions {
  /** Trusted read-only liquidity adapter. No value means fail closed. */
  liquidity?: (mint: string) => Promise<RiskLiquidity | null>;
  /** Owner CLI capability, never exposed by a strategy dispatcher. */
  ownerPaperScenario?: boolean;
}

export class RiskManager {
  private readonly model: PaperModel;
  constructor(
    private readonly pool: Pool,
    private readonly provider: PaperQuoteProvider,
    model: PaperModel,
    private readonly options: RiskOptions = {},
  ) {
    validateModel(model);
    this.model = JSON.parse(JSON.stringify(model)) as PaperModel;
  }
  /** Strategy capability exposes no pool, sizing, executor, manual registration or scenario flag. */
  forStrategy(
    botId: string,
    assignedStrategy: string,
  ): {
    submitSignal: (
      signal: unknown,
      key: string,
      target?: OpportunityTarget,
    ) => Promise<RiskDecision>;
  } {
    if (this.options.ownerPaperScenario)
      throw new Error('OWNER_SCENARIO_IS_NOT_STRATEGY_CAPABILITY');
    return Object.freeze({
      submitSignal: (signal: unknown, key: string, target?: OpportunityTarget) =>
        this.submitSignal(botId, assignedStrategy, signal, key, target),
    });
  }
  async submitSignal(
    botId: string,
    assignedStrategy: string,
    signalInput: unknown,
    key: string,
    targetInput?: OpportunityTarget,
  ): Promise<RiskDecision> {
    // Bound serialization before hashing; free-form signal reason is never persisted.
    let signal: unknown = signalInput,
      target: OpportunityTarget | undefined = targetInput,
      invalid = false;
    try {
      const serialized = JSON.stringify([signalInput, targetInput]);
      if (serialized.length > 32768) throw new Error();
      [signal, target] = JSON.parse(serialized) as [unknown, OpportunityTarget | undefined];
    } catch {
      invalid = true;
      signal = null;
      target = undefined;
    }
    const scope = riskHash(
      typeof botId === 'string' && botId.length <= 100 ? botId : 'invalid-bot',
    );
    const requestHash = riskHash([assignedStrategy, signal, target ?? null]);
    const requestKey =
      typeof key === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(key)
        ? key
        : `invalid:${randomUUID()}`;
    const old = (
      await this.pool
        .query<{
          id: string;
          status: 'approved' | 'vetoed';
          code: string;
          intent: ApprovedOrderIntent | null;
          request_hash: string;
        }>('SELECT * FROM risk_decisions WHERE scope=$1 AND request_key=$2', [scope, requestKey])
        .catch(() => {
          throw new Error('RISK_STORAGE_UNAVAILABLE_NO_DECISION_COMMITTED');
        })
    ).rows[0];
    if (old && old.request_hash === requestHash)
      return old.status === 'approved'
        ? { id: old.id, status: 'approved', intent: old.intent! }
        : { id: old.id, status: 'vetoed', code: old.code };
    let preCode: string | undefined;
    let preMetrics: Record<string, string | number> = {};
    let bot: Bot | undefined,
      profile: RiskProfile | null = null,
      quotedPrincipal = 0n,
      quote: Awaited<ReturnType<PaperQuoteProvider['quote']>> | undefined;
    let safety: Awaited<ReturnType<SafetyStore['read']>> = null,
      liquidity: RiskLiquidity | null = null;
    const orderId = randomUUID(),
      admissionId = randomUUID();
    let draft: ApprovedOrderIntent | undefined;
    try {
      if (old) deny('IDEMPOTENCY_CONFLICT');
      if (
        invalid ||
        requestKey !== key ||
        !signalValid(signal) ||
        !UUID.test(botId) ||
        !/^[a-z][a-z0-9_]{1,39}$/.test(assignedStrategy)
      )
        deny('INVALID_SIGNAL');
      if (signal.side === 'sell') deny('EXIT_MANAGER_REQUIRED');
      if (
        !target ||
        !isProfileObject(target) ||
        Object.keys(target).sort().join(',') !== 'expiresAt,mint,observedAt,priceSol,provenance' ||
        target.mint !== signal.token ||
        decimalRatio(target.priceSol).n <= 0n ||
        !fresh(target, Date.now())
      )
        deny('TARGET_UNAVAILABLE');
      bot = (await this.pool.query<Bot>('SELECT * FROM bots WHERE id=$1', [botId])).rows[0];
      if (!bot) deny('BOT_NOT_FOUND');
      if (bot.strategy !== assignedStrategy) deny('STRATEGY_ASSIGNMENT_MISMATCH');
      if (bot.mode !== 'paper') deny('BOT_NOT_PAPER');
      await reconcileRiskAdmissions(this.pool, botId);
      profile = await getRiskProfile(this.pool, bot.risk_profile_id);
      if (!profile || validateRiskProfile(profileConfig(profile)).length) deny('INVALID_PROFILE');
      safety = await new SafetyStore(this.pool).read(`solana:${signal.token}:none`);
      if (!safety) deny('SAFETY_UNAVAILABLE');
      const raw = validateEvidence(safety.evidence),
        decision = evaluate(
          raw,
          profileSafetyPolicy(profile),
          Math.max(Date.now(), safety.now.getTime()),
        );
      if (
        raw.mint !== signal.token ||
        raw.pool !== null ||
        raw.decimals === null ||
        safety.expiresAt.getTime() <= Date.now() ||
        safety.expiresAt.getTime() !==
          Math.min(...CHECKS.map((c) => Date.parse(raw.checks[c].expiresAt)))
      )
        deny('SAFETY_UNAVAILABLE');
      if (decision.scenario && !this.options.ownerPaperScenario)
        deny('SCENARIO_EVIDENCE_FORBIDDEN');
      if (!decision.passed) deny('SAFETY_DENIED');
      liquidity = (await this.options.liquidity?.(signal.token)) ?? null;
      if (
        !liquidity ||
        !isProfileObject(liquidity) ||
        Object.keys(liquidity).sort().join(',') !== 'expiresAt,mint,observedAt,provenance,usd' ||
        liquidity.mint !== signal.token ||
        !fresh(liquidity, Date.now())
      )
        deny('LIQUIDITY_UNAVAILABLE');
      const actual = decimalRatio(liquidity.usd),
        min = decimalRatio(profile.minLiquidityUsd);
      if (actual.n * min.d < min.n * actual.d)
        deny('MIN_LIQUIDITY', { actualUsd: liquidity.usd, minUsd: profile.minLiquidityUsd });
      if (this.model.adverseSlippageBps > profile.maxSlippageBps)
        deny('MAX_SLIPPAGE', {
          actualBps: this.model.adverseSlippageBps,
          maxBps: profile.maxSlippageBps,
        });
      const exposure = await riskExposure(this.pool, botId);
      const available = BigInt(bot.paper_bankroll_lamports) - exposure.debit - exposure.feeCash;
      const fee =
        BigInt(this.model.fees.networkLamports) + BigInt(this.model.fees.priorityLamports);
      quotedPrincipal = fractionFloor(available > 0n ? available : 0n, profile.positionFraction);
      const affordable = available - fee * BigInt(MAX_ATTEMPTS + 1);
      if (quotedPrincipal > affordable) quotedPrincipal = affordable;
      if (quotedPrincipal <= 0n) deny('INSUFFICIENT_PAPER_CASH');
      const maxSafetyAge = profileSafetyPolicy(profile).maxAgeMs;
      const expiresAt = Math.min(
        Date.now() + 5000,
        target.expiresAt,
        liquidity.expiresAt,
        safety.expiresAt.getTime(),
        ...CHECKS.map((c) => Date.parse(raw.checks[c].observedAt) + maxSafetyAge),
        target.observedAt + 30000,
        liquidity.observedAt + 30000,
      );
      draft = {
        orderId,
        clientOrderId: `risk:${admissionId}`,
        botId,
        positionId: null,
        tokenMint: signal.token,
        side: 'buy',
        mode: 'paper',
        amountInRaw: quotedPrincipal.toString(),
        maxSlippageBps: profile.maxSlippageBps,
        expiresAt,
        approval: { kind: 'risk_manager', reference: admissionId },
        quoteRequirements: {
          freshnessPolicy: 'bounded_request_age',
          maxAgeMs: 5000,
          maxSlotLag: 0,
          fullyObservedCosts: false,
        },
        entry: { stopPriceSol: '0.1', takeProfit: profile.takeProfitLadder },
        closeReason: null,
      };
      quote = await this.provider.quote({ intent: draft, inputRaw: draft.amountInRaw });
      quote = JSON.parse(JSON.stringify(quote)) as typeof quote;
      if (quote.status !== 'available') deny('QUOTE_UNAVAILABLE');
      validateExecutableQuote(quote.quote, { intent: draft, inputRaw: draft.amountInRaw });
      if (!quoteIsFresh(quote.quote, draft, undefined, Date.now())) deny('QUOTE_STALE');
    } catch (error) {
      preCode = error instanceof Veto ? error.message : 'EVIDENCE_UNAVAILABLE';
      if (error instanceof Veto) preMetrics = error.metrics;
    }
    try {
      return await withTransaction(this.pool, async (db) => {
        const current = UUID.test(botId)
          ? (await db.query<Bot>('SELECT * FROM bots WHERE id=$1 FOR UPDATE', [botId])).rows[0]
          : undefined;
        const previous = (
          await db.query<{
            id: string;
            status: 'approved' | 'vetoed';
            code: string;
            intent: ApprovedOrderIntent | null;
            request_hash: string;
          }>('SELECT * FROM risk_decisions WHERE scope=$1 AND request_key=$2', [scope, requestKey])
        ).rows[0];
        if (previous && previous.request_hash === requestHash)
          return previous.status === 'approved'
            ? { id: previous.id, status: 'approved', intent: previous.intent! }
            : { id: previous.id, status: 'vetoed', code: previous.code };
        const decisionId = randomUUID();
        const veto = async (
          code: string,
          metrics: Record<string, string | number> = {},
        ): Promise<RiskDecision> => {
          await db.query(
            "INSERT INTO risk_decisions(id,scope,request_key,request_hash,bot_id,status,code,metrics) VALUES($1,$2,$3,$4,$5,'vetoed',$6,$7)",
            [
              decisionId,
              scope,
              previous ? `conflict:${randomUUID()}` : requestKey,
              requestHash,
              current?.id ?? null,
              code,
              JSON.stringify(metrics),
            ],
          );
          await recordAudit(db, {
            actor: 'system',
            action: 'risk.vetoed',
            entityType: 'risk_decision',
            entityId: decisionId,
            details: { code, metrics, ...(current ? { botId: current.id } : {}) },
          });
          return { id: decisionId, status: 'vetoed', code };
        };
        if (previous) return veto('IDEMPOTENCY_CONFLICT');
        if (preCode) return veto(preCode, preMetrics);
        try {
          if (
            !current ||
            !bot ||
            !profile ||
            !draft ||
            !safety ||
            !liquidity ||
            !target ||
            !signalValid(signal) ||
            quote?.status !== 'available'
          )
            deny('EVIDENCE_UNAVAILABLE');
          if (riskConfigHash(current) !== riskConfigHash(bot)) deny('CONFIG_CHANGED');
          // Shared profile row lock serializes owner edits through admission commit.
          await db.query('SELECT id FROM risk_profiles WHERE id=$1 FOR SHARE', [
            current.risk_profile_id,
          ]);
          const latest = await getRiskProfile(db, current.risk_profile_id);
          if (!latest || latest.revision !== profile.revision) deny('PROFILE_CHANGED');
          const day = await ensureRiskDay(db, botId);
          if (!fresh(target, day.now)) deny('TARGET_EXPIRED');
          if (!fresh(liquidity, day.now)) deny('LIQUIDITY_UNAVAILABLE');
          const saved = (
            await db.query<{ evidence: unknown; expires_at: Date }>(
              'SELECT evidence,expires_at FROM token_safety_snapshots WHERE id=$1',
              [safety.id],
            )
          ).rows[0];
          if (
            !saved ||
            saved.expires_at.getTime() <= day.now ||
            riskCanonical(saved.evidence) !== riskCanonical(safety.evidence)
          )
            deny('SAFETY_UNAVAILABLE');
          const raw = validateEvidence(saved.evidence),
            safetyDecision = evaluate(raw, profileSafetyPolicy(latest), day.now);
          if (
            !safetyDecision.passed ||
            (safetyDecision.scenario && !this.options.ownerPaperScenario)
          )
            deny('SAFETY_DENIED');
          const cache = (
            await db.query<{ snapshot_id: string }>(
              'SELECT snapshot_id FROM token_safety_cache WHERE cache_key=$1 FOR SHARE',
              [`solana:${signal.token}:none`],
            )
          ).rows[0];
          if (cache?.snapshot_id !== safety.id) deny('SAFETY_CHANGED');
          if (!quoteIsFresh(quote.quote, draft, undefined, day.now) || day.now >= draft.expiresAt)
            deny('QUOTE_STALE');
          const token = (
            await db.query<{ decimals: number }>('SELECT decimals FROM tokens WHERE mint=$1', [
              signal.token,
            ])
          ).rows[0];
          if (!token || token.decimals !== raw.decimals) deny('TOKEN_UNAVAILABLE');
          const count = (
            await db.query<{ n: string; duplicate: boolean }>(
              `WITH entries AS (
            SELECT token_mint FROM positions WHERE bot_id=$1 AND mode='paper' AND status='open'
            UNION SELECT o.token_mint FROM risk_reservations r JOIN risk_admissions a ON a.id=r.admission_id JOIN orders o ON o.id=a.order_id WHERE r.bot_id=$1 AND r.state='active')
            SELECT count(*)::text n,COALESCE(bool_or(token_mint=$2),false) duplicate FROM entries`,
              [botId, signal.token],
            )
          ).rows[0]!;
          if (count.duplicate) deny('POSITION_ALREADY_OPEN_OR_PENDING');
          if (BigInt(count.n) >= BigInt(latest.maxOpenPositions))
            deny('MAX_OPEN_POSITIONS', { actual: count.n, limit: latest.maxOpenPositions });
          if (
            (
              await db.query(
                "SELECT 1 FROM positions p LEFT JOIN risk_position_commitments c ON c.position_id=p.id WHERE p.bot_id=$1 AND p.mode='paper' AND p.status='open' AND c.position_id IS NULL",
                [botId],
              )
            ).rowCount
          )
            deny('OPEN_RISK_UNKNOWN');
          const streak =
            (
              await db.query<{ losses: number }>(
                'SELECT losses FROM risk_streaks WHERE bot_id=$1',
                [botId],
              )
            ).rows[0]?.losses ?? 0;
          if (streak >= latest.losingStreakLimit)
            deny('LOSING_STREAK_LIMIT', { actual: streak, limit: latest.losingStreakLimit });
          const exposure = await riskExposure(db, botId),
            cash = BigInt(current.paper_bankroll_lamports) - exposure.debit - exposure.feeCash;
          const fee =
              BigInt(this.model.fees.networkLamports) + BigInt(this.model.fees.priorityLamports),
            fees = fee * BigInt(MAX_ATTEMPTS);
          let size = fractionFloor(cash > 0n ? cash : 0n, latest.positionFraction);
          if (size > cash - fees - fee) size = cash - fees - fee;
          if (size <= 0n) deny('INSUFFICIENT_PAPER_CASH');
          if (size !== quotedPrincipal) deny('CASH_CHANGED_REQUOTE_REQUIRED');
          if (size > fractionFloor(cash, '0.05')) deny('HARD_POSITION_LIMIT');
          const cap = (
            await db.query<{
              cap_lamports: string;
              consumed_lamports: string;
              wallet_cap: string | null;
            }>(
              `SELECT c.*,w.spend_cap_lamports::text wallet_cap FROM risk_paper_accounts c JOIN bots b ON b.id=c.bot_id JOIN wallets w ON w.id=b.wallet_id WHERE c.bot_id=$1 FOR UPDATE OF c`,
              [botId],
            )
          ).rows[0];
          if (!cap || cap.wallet_cap === null) deny('PAPER_CAP_NOT_CONFIGURED');
          const debit = size + fees + fee;
          if (
            BigInt(cap.consumed_lamports) + exposure.debit + exposure.feeCash + debit >
              BigInt(cap.cap_lamports) ||
            BigInt(cap.consumed_lamports) + exposure.debit + exposure.feeCash + debit >
              BigInt(cap.wallet_cap)
          )
            deny('PAPER_CAP_EXCEEDED', {
              consumed: cap.consumed_lamports,
              reserved: (exposure.debit + exposure.feeCash).toString(),
              requested: debit.toString(),
              paperCap: cap.cap_lamports,
              walletCap: cap.wallet_cap,
            });
          const quantity = BigInt(quote.quote.minimumOutputRaw),
            entryN = size * 10n ** BigInt(token.decimals),
            entryD = quantity * 1000000000n,
            targetPrice = decimalRatio(target.priceSol);
          if (
            targetPrice.n * entryD <= entryN * targetPrice.d ||
            targetPrice.n * entryD > entryN * targetPrice.d * 1000n
          )
            deny('TARGET_IMPLAUSIBLE');
          const economics = netRewardRisk({
            principal: size,
            quantity,
            decimals: token.decimals,
            targetPriceSol: target.priceSol,
            stopFraction: latest.stopLossFraction,
            slippageBps: latest.maxSlippageBps,
            adverseBps: this.model.adverseSlippageBps,
            entryFees: fees,
            exitFees: fee,
          });
          const rr = decimalRatio(latest.minRewardRisk);
          if (economics.reward < 0n || economics.reward * rr.d < economics.loss * rr.n)
            deny('MIN_REWARD_RISK', {
              reward: economics.reward.toString(),
              loss: economics.loss.toString(),
              minRR: latest.minRewardRisk,
            });
          // Fixed fees do not scale down with a partial fill. Every executable
          // prefix must retain net RR even if all reserved entry fees are spent.
          let remainingPrincipal = size,
            cumulativePrincipal = 0n,
            cumulativeQuantity = 0n;
          for (let prefix = 1; prefix <= MAX_ATTEMPTS; prefix++) {
            const partial = (remainingPrincipal * BigInt(this.model.partialFillBps)) / 10000n;
            if (partial <= 0n) deny('PARTIAL_AMOUNT_TOO_SMALL');
            cumulativePrincipal += partial;
            cumulativeQuantity += ceilDiv(quantity * partial, size);
            const partialEconomics = netRewardRisk({
              principal: cumulativePrincipal,
              quantity: cumulativeQuantity,
              decimals: token.decimals,
              targetPriceSol: target.priceSol,
              stopFraction: latest.stopLossFraction,
              stopPriceSol: economics.stopPriceSol,
              slippageBps: latest.maxSlippageBps,
              adverseBps: this.model.adverseSlippageBps,
              entryFees: fees,
              exitFees: fee,
            });
            if (
              partialEconomics.reward < 0n ||
              partialEconomics.reward * rr.d < partialEconomics.loss * rr.n
            )
              deny('PARTIAL_MODEL_NET_REWARD_RISK', {
                prefix,
                principal: cumulativePrincipal.toString(),
                reward: partialEconomics.reward.toString(),
                loss: partialEconomics.loss.toString(),
                minRR: latest.minRewardRisk,
              });
            remainingPrincipal -= partial;
            if (remainingPrincipal === 0n) break;
          }
          if (day.used + exposure.loss + economics.loss > day.limit)
            deny('DAILY_LOSS_LIMIT', {
              used: day.used.toString(),
              reserved: exposure.loss.toString(),
              requested: economics.loss.toString(),
              limit: day.limit.toString(),
            });
          const intent: ApprovedOrderIntent = {
            ...draft,
            expiresAt: Math.min(draft.expiresAt, quote.quote.expiresAt),
            entry: { stopPriceSol: economics.stopPriceSol, takeProfit: latest.takeProfitLadder },
          };
          await db.query(
            "INSERT INTO orders(id,client_order_id,bot_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,'buy','paper',$5,$6,'RISK_APPROVED')",
            [
              orderId,
              intent.clientOrderId,
              botId,
              signal.token,
              size.toString(),
              latest.maxSlippageBps,
            ],
          );
          await db.query(
            "INSERT INTO risk_decisions(id,scope,request_key,request_hash,bot_id,status,code,intent) VALUES($1,$2,$3,$4,$5,'approved','APPROVED',$6)",
            [decisionId, scope, requestKey, requestHash, botId, JSON.stringify(intent)],
          );
          await db.query(
            `INSERT INTO risk_admissions(id,decision_id,order_id,bot_id,intent,profile_id,profile_revision,config_hash,model,max_attempts,snapshot_id,safety_fingerprint,assumptions,expires_at,principal_lamports,loss_lamports)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14::double precision/1000),$15,$16)`,
            [
              admissionId,
              decisionId,
              orderId,
              botId,
              JSON.stringify(intent),
              latest.id,
              latest.revision,
              riskConfigHash(current),
              JSON.stringify(this.model),
              MAX_ATTEMPTS,
              safety.id,
              safetyDecision.policyFingerprint,
              JSON.stringify({
                formula: 'net_target_stop_v1',
                target,
                liquidity,
                safetyPolicy: profileSafetyPolicy(latest),
                scenario: safetyDecision.scenario,
                entryQuote: quote.quote,
                rewardLamports: economics.reward.toString(),
                lossLamports: economics.loss.toString(),
                economicsPolicy: {
                  decimals: token.decimals,
                  minRR: latest.minRewardRisk,
                  stopFraction: latest.stopLossFraction,
                  slippageBps: latest.maxSlippageBps,
                  adverseBps: this.model.adverseSlippageBps,
                  entryFeeBudget: fees.toString(),
                  exitFee: fee.toString(),
                },
              }),
              intent.expiresAt,
              size.toString(),
              economics.loss.toString(),
            ],
          );
          await db.query(
            "INSERT INTO risk_reservations(admission_id,bot_id,debit_remaining,loss_remaining,state) VALUES($1,$2,$3,$4,'active')",
            [admissionId, botId, debit.toString(), economics.loss.toString()],
          );
          await registerPaperIntentInTransaction(db, intent);
          await recordAudit(db, {
            actor: this.options.ownerPaperScenario ? 'owner' : 'system',
            action: 'risk.approved',
            entityType: 'risk_decision',
            entityId: decisionId,
            details: {
              botId,
              orderId,
              profileRevision: latest.revision,
              principalLamports: size.toString(),
              lossLamports: economics.loss.toString(),
              scenario: safetyDecision.scenario,
            },
          });
          return { id: decisionId, status: 'approved', intent };
        } catch (error) {
          if (error instanceof Veto) return veto(error.message, error.metrics);
          throw error;
        }
      });
    } catch {
      throw new Error('RISK_STORAGE_UNAVAILABLE_NO_DECISION_COMMITTED');
    }
  }
}

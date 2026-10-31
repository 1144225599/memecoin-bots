/** Execution consumes fixed, approved quantities. It never selects trades, sizes or exits. */
export const PAPER_SOL_MINT = 'So11111111111111111111111111111111111111112';
export interface ApprovedOrderIntent {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly botId: string;
  readonly positionId: string | null;
  readonly tokenMint: string;
  readonly side: 'buy' | 'sell';
  readonly mode: 'paper' | 'live';
  readonly amountInRaw: string;
  readonly maxSlippageBps: number;
  readonly expiresAt: number;
  readonly approval: Readonly<{
    kind: 'risk_manager' | 'exit_manager' | 'manual_paper_scenario';
    reference: string;
  }>;
  readonly quoteRequirements: Readonly<{
    freshnessPolicy: 'bounded_request_age' | 'chain_context';
    maxAgeMs: number;
    maxSlotLag: number;
    fullyObservedCosts: boolean;
  }>;
  /** Buy entry metadata is supplied by approval, never invented by executor. */
  readonly entry: Readonly<{
    stopPriceSol: string;
    takeProfit: readonly Readonly<{ atGain: number; sellFraction: number }>[];
  }> | null;
  readonly closeReason:
    | 'stop_loss'
    | 'take_profit'
    | 'trailing_stop'
    | 'time_stop'
    | 'kill_switch'
    | 'manual'
    | 'strategy_exit'
    | null;
}
export interface ExecutionResult {
  readonly attemptId: string;
  readonly orderId: string;
  readonly status: 'filled' | 'partial' | 'failed' | 'unavailable' | 'cancelled';
  readonly reason: string;
  readonly inputRaw: string;
  readonly outputRaw: string;
  readonly networkFeeLamports: string;
  readonly priorityFeeLamports: string;
  readonly costsProvenance: 'MODEL' | 'OBSERVED';
  readonly quoteProvenance?: Readonly<{
    provider: string;
    freshnessBasis: string;
    feeBreakdownCompleteness: string;
    unknownFeeComponents: readonly string[];
  }>;
}
export interface Executor {
  execute(intent: ApprovedOrderIntent, idempotencyKey: string): Promise<ExecutionResult>;
  inspect(orderId: string): Promise<readonly ExecutionResult[]>;
  cancel(orderId: string): Promise<void>;
}
/** Production cannot enable live by injecting an adapter. Fake-live substitution is test-only. */
export function createExecutor(mode: 'paper' | 'live', paper: Executor): Executor {
  if (mode !== 'paper') throw new Error('LIVE_EXECUTOR_UNAVAILABLE');
  return paper;
}
export function createTestExecutor(
  mode: 'paper' | 'live',
  adapters: { paper: Executor; fakeLive: Executor },
): Executor {
  return mode === 'paper' ? adapters.paper : adapters.fakeLive;
}
export interface PaperModel {
  readonly version: 'paper-v1';
  readonly minLatencyMs: number;
  readonly maxLatencyMs: number;
  readonly adverseSlippageBps: number;
  readonly failureProbability: number;
  readonly failureStage: 'before_submission' | 'submitted';
  readonly partialFillBps: number;
  readonly fees: Readonly<{
    provenance: 'MODEL';
    selectedBy: string;
    networkLamports: string;
    priorityLamports: string;
  }>;
}
export interface PaperDraws {
  readonly latencyMs: number;
  readonly failurePpm: number;
}
export interface QuoteFee {
  readonly kind: 'swap' | 'platform';
  readonly mint: string;
  readonly amountRaw: string | null;
  readonly rateBps: number | null;
  /** Already reflected in ExactIn input/output; NEVER debit again. */
  readonly inclusion: 'embedded';
}
export interface ExecutableQuote {
  readonly provider: 'jupiter-v2' | 'local_mock';
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputRaw: string;
  readonly outputRaw: string;
  readonly providerMinimumOutputRaw: string;
  readonly minimumOutputRaw: string;
  readonly slippageBps: number;
  readonly contextSlot: number | null;
  readonly contextBlockTimeMs: number | null;
  readonly freshnessBasis: 'chain_context' | 'bounded_request_age_MODEL';
  readonly requestStartedAt: number;
  readonly responseId: string | null;
  readonly totalFeeBps: number;
  readonly feeBreakdownCompleteness: 'partial' | 'complete';
  readonly unknownFeeComponents: readonly string[];
  readonly transactionFeeEstimates: Readonly<{
    networkLamports: string | null;
    priorityLamports: string | null;
    rentLamports: string | null;
    scope: 'quote_only_no_taker';
  }>;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly route: readonly string[];
  readonly fees: readonly QuoteFee[];
}
export type QuoteEvidence =
  | Readonly<{ status: 'available'; quote: ExecutableQuote }>
  | Readonly<{ status: 'unavailable'; reason: string }>;
export interface ChainContext {
  readonly slot: number;
  readonly blockTimeMs: number;
  readonly observedAt: number;
}

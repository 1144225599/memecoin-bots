import type { ApprovedOrderIntent } from './execution.js';

export interface OpportunityTarget {
  readonly mint: string;
  readonly priceSol: string;
  readonly provenance: string;
  readonly observedAt: number;
  readonly expiresAt: number;
}
export interface RiskLiquidity {
  readonly mint: string;
  readonly usd: string;
  readonly provenance: string;
  readonly observedAt: number;
  readonly expiresAt: number;
}
export type RiskDecision =
  | { readonly id: string; readonly status: 'vetoed'; readonly code: string }
  | { readonly id: string; readonly status: 'approved'; readonly intent: ApprovedOrderIntent };

export interface Ratio {
  readonly n: bigint;
  readonly d: bigint;
}
/** Bounded plain decimal, exact even above 2^53; no Number conversion. */
export function decimalRatio(value: string): Ratio {
  if (typeof value !== 'string' || value.length > 80 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    throw new Error('INVALID_DECIMAL');
  const [whole = '', fraction = ''] = value.split('.');
  return { n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length) };
}
export function fractionFloor(value: bigint, fraction: string): bigint {
  const r = decimalRatio(fraction);
  return (value * r.n) / r.d;
}
export function ceilDiv(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error('INVALID_RATIO');
  return (n + d - 1n) / d;
}
export function ratioDecimal(n: bigint, d: bigint, places = 30): string {
  if (n <= 0n || d <= 0n) throw new Error('INVALID_PRICE');
  const scale = 10n ** BigInt(places),
    v = (n * scale) / d;
  if (v === 0n) throw new Error('PRICE_PRECISION_UNAVAILABLE');
  return `${v / scale}.${(v % scale).toString().padStart(places, '0')}`;
}
/** Conservative integer MODEL: entry worst output, target/stop adverse exit and explicit fees. */
export function protectedStopProceeds(
  quantity: bigint,
  decimals: number,
  priceSol: string,
  slippageBps: number,
  adverseBps: number,
): bigint {
  const price = decimalRatio(priceSol);
  return (
    (((((quantity * price.n * 1000000000n) / (price.d * 10n ** BigInt(decimals))) *
      BigInt(10000 - slippageBps)) /
      10000n) *
      BigInt(10000 - adverseBps)) /
    10000n
  );
}
export function netRewardRisk(input: {
  principal: bigint;
  quantity: bigint;
  decimals: number;
  targetPriceSol: string;
  stopFraction: string;
  slippageBps: number;
  adverseBps: number;
  entryFees: bigint;
  exitFees: bigint;
  stopPriceSol?: string;
}): { reward: bigint; loss: bigint; stopPriceSol: string } {
  const target = decimalRatio(input.targetPriceSol),
    stop = decimalRatio(input.stopFraction);
  const adverse = (v: bigint) =>
    (((v * BigInt(10000 - input.slippageBps)) / 10000n) * BigInt(10000 - input.adverseBps)) /
    10000n;
  const proceeds =
    (input.quantity * target.n * 1_000_000_000n) / (target.d * 10n ** BigInt(input.decimals));
  const stopPriceSol =
    input.stopPriceSol ??
    ratioDecimal(
      input.principal * 10n ** BigInt(input.decimals) * (stop.d - stop.n),
      input.quantity * 1000000000n * stop.d,
    );
  const stopProceeds = protectedStopProceeds(
    input.quantity,
    input.decimals,
    stopPriceSol,
    input.slippageBps,
    input.adverseBps,
  );
  const book = input.principal + input.entryFees;
  return {
    reward: adverse(proceeds) - input.principal - input.entryFees - input.exitFees,
    loss: (book > stopProceeds ? book - stopProceeds : 0n) + input.exitFees,
    stopPriceSol,
  };
}

import { describe, expect, it } from 'vitest';
import { decimalRatio, fractionFloor, netRewardRisk } from './risk-admission.js';
describe('exact risk economics', () => {
  it('does not round size above the 5% ceiling or lose large balances', () => {
    expect(fractionFloor(900719925474099300000n, '0.05')).toBe(45035996273704965000n);
    expect(
      decimalRatio('0.050000000000000000001').n * 100n >
        decimalRatio('0.050000000000000000001').d * 5n,
    ).toBe(true);
  });
  it('computes absent/below/equal net RR boundaries without floats', () => {
    const base = {
      principal: 1000000000n,
      quantity: 1000000000n,
      decimals: 9,
      stopFraction: '0.2',
      slippageBps: 0,
      adverseBps: 0,
      entryFees: 0n,
      exitFees: 0n,
    };
    const exact = netRewardRisk({ ...base, targetPriceSol: '1.4' });
    expect(exact.reward).toBe(400000000n);
    expect(exact.loss).toBe(200000000n);
    expect(exact.reward >= exact.loss * 2n).toBe(true);
    expect(
      netRewardRisk({ ...base, targetPriceSol: '1.3999999999999999999' }).reward < exact.loss * 2n,
    ).toBe(true);
    expect(
      netRewardRisk({ ...base, targetPriceSol: '1.4', entryFees: 5n, exitFees: 5n }).reward <
        exact.loss * 2n,
    ).toBe(true);
  });
});

import type { BotMode } from './bot.js';
import type { RiskProfile } from './risk.js';

export interface StrategyDescriptor {
  readonly id: string;
  readonly name: string;
  readonly available: false;
  readonly recommendedProfiles: readonly string[];
}
/** Configuration descriptors only. No strategy implementation is installed. */
export const STRATEGY_CATALOG: readonly StrategyDescriptor[] = [
  {
    id: 'sniper',
    name: 'Launch sniper',
    available: false,
    recommendedProfiles: ['aggressive', 'degen'],
  },
  {
    id: 'momentum',
    name: 'Momentum breakout',
    available: false,
    recommendedProfiles: ['balanced', 'aggressive'],
  },
  {
    id: 'copy_trade',
    name: 'Smart-wallet copy trading',
    available: false,
    recommendedProfiles: ['balanced', 'aggressive'],
  },
  {
    id: 'dip_buy',
    name: 'Dip buy / mean reversion',
    available: false,
    recommendedProfiles: ['conservative', 'balanced'],
  },
  { id: 'dca_grid', name: 'DCA / grid', available: false, recommendedProfiles: ['conservative'] },
];
export interface PreparedWallet {
  readonly id: string;
  readonly label: string;
  readonly publicKey: string;
  readonly spendCapLamports: string;
}
export interface ControlledBot {
  readonly id: string;
  readonly name: string;
  readonly strategy: string;
  readonly strategyParams: Readonly<Record<string, unknown>>;
  readonly riskProfileId: string;
  readonly walletId: string;
  readonly publicKey: string;
  readonly spendCapLamports: string | null;
  readonly paperBankrollLamports: string;
  readonly observedBalanceLamports: string | null;
  readonly balanceObservedAt: string | null;
  readonly mode: BotMode;
  readonly revision: string;
  readonly openPositions: number;
  readonly pendingOrders: number;
  readonly strategyAvailable: false;
}
export interface BotConfiguration {
  readonly name: string;
  readonly strategy: string;
  readonly strategyParams: Readonly<Record<string, never>>;
  readonly riskProfileId: string;
}
export interface CreateBotRequest extends BotConfiguration {
  readonly walletId: string;
  readonly paperBankrollLamports: string;
}
export interface BotControlSnapshot {
  readonly bots: readonly ControlledBot[];
  readonly wallets: readonly PreparedWallet[];
  readonly profiles: readonly RiskProfile[];
  readonly strategies: readonly StrategyDescriptor[];
  readonly liveTradingAvailable: false;
}

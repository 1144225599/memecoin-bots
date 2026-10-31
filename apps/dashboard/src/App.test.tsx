import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RISK_WARNING } from '@memebots/core';

import { App, describeHealth } from './App';

describe('App', () => {
  it('always shows the risk warning', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Risk warning');
    expect(html).toContain(RISK_WARNING.slice(0, 60));
  });
});

describe('describeHealth', () => {
  it('says plainly that live trading is not available yet', () => {
    expect(describeHealth({ state: 'ok', mode: 'paper', liveTradingAvailable: false })).toBe(
      'API is up. Mode: paper. Live trading: not available yet.',
    );
    expect(describeHealth({ state: 'down' })).toMatch(/not reachable/);
  });
});

import { STRATEGY_CATALOG } from '@memebots/core';
import type { BotControlSnapshot, ControlledBot } from '@memebots/core';
import { BotForm, errorMessage, formatSol } from './App';
const empty: BotControlSnapshot = {
  bots: [],
  wallets: [],
  profiles: [],
  strategies: STRATEGY_CATALOG,
  liveTradingAvailable: false,
};
describe('bot control rendering and recovery', () => {
  it('renders honest loading, paper and live limitations', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Loading your workspace');
    expect(html).toContain('LIVE LOCKED');
    expect(html).toContain('All strategies are currently unavailable');
  });
  it('renders the exact offline wallet prerequisite without private-key input', () => {
    const html = renderToString(<BotForm snapshot={empty} busy={false} onSave={() => {}} />);
    expect(html).toContain('No prepared wallets available');
    expect(html).toContain('pnpm wallet prepare');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="password"');
  });
  it('renders persisted account units, profile pairing warning and legacy strategy honestly', () => {
    const bot = {
      id: 'one',
      name: 'Observer',
      strategy: 'legacy',
      strategyParams: {},
      riskProfileId: 'balanced',
      walletId: 'wallet',
      publicKey: 'public-address',
      spendCapLamports: '1000000000',
      paperBankrollLamports: '900719925474099312345',
      observedBalanceLamports: null,
      balanceObservedAt: null,
      mode: 'paper',
      revision: '1',
      openPositions: 0,
      pendingOrders: 0,
      strategyAvailable: false,
    } as const satisfies ControlledBot;
    const html = renderToString(
      <BotForm snapshot={empty} bot={bot} busy={false} onSave={() => {}} />,
    );
    expect(html).toContain('Legacy strategy ID');
    expect(html).toContain('900719925474.099312345');
    expect(html).toContain('Not observed');
    expect(html).toContain('fixed after creation');
    const configured = renderToString(
      <BotForm
        snapshot={empty}
        bot={{ ...bot, strategyParams: { watchlist: ['public-mint'] } }}
        busy={false}
        onSave={() => {}}
      />,
    );
    expect(configured).toContain('Existing strategy parameters are preserved');
    expect(configured).toContain('Changing this strategy requires an explicit offline review');
    expect(configured).not.toContain('public-mint');
  });
  it('keeps integer amounts exact and gives actionable conflict/live errors', () => {
    expect(formatSol('900719925474099312345')).toBe('900719925474.099312345');
    expect(formatSol('1')).toBe('0.000000001');
    expect(errorMessage('STALE_REVISION')).toContain('Reload');
    expect(errorMessage('WALLET_NOT_AVAILABLE')).toContain('claimed');
    expect(errorMessage('LIVE_EXECUTOR_UNAVAILABLE')).toContain('has not changed');
  });
});

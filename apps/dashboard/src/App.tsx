import { useEffect, useRef, useState } from 'react';
import { DialogFocusReturn } from './dialog-focus';
import { RISK_WARNING } from '@memebots/core';
import type {
  BotConfiguration,
  BotControlSnapshot,
  ControlledBot,
  CreateBotRequest,
} from '@memebots/core';

type Health =
  | { state: 'loading' }
  | { state: 'ok'; mode: string; liveTradingAvailable: boolean }
  | { state: 'down' };
export function describeHealth(health: Health): string {
  if (health.state === 'loading') return 'Checking the API…';
  if (health.state === 'down') return 'The API is not reachable. Start it with "pnpm dev:api".';
  return `API is up. Mode: ${health.mode}. Live trading: ${health.liveTradingAvailable ? 'available' : 'not available yet'}.`;
}
export function formatSol(raw: string): string {
  const n = BigInt(raw),
    whole = n / 1_000_000_000n,
    fraction = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
export function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    STALE_REVISION:
      'This bot changed in another session. Reload the current configuration before saving again.',
    WALLET_NOT_AVAILABLE:
      'That wallet was claimed by another bot. Reload and select an available wallet.',
    CONFIGURATION_CONFLICT:
      'That bot name or wallet is already in use. Choose another and try again.',
    PENDING_ORDERS:
      'Pending orders must finish or be cancelled before changing configuration. Switch the bot off to cancel them.',
    LIVE_EXECUTOR_UNAVAILABLE:
      'Live trading is unavailable. The live executor and kill switch are not implemented. The bot mode has not changed.',
    LEGACY_PARAMETERS_REQUIRE_OFFLINE_REVIEW:
      'Existing strategy parameters must be reviewed offline before changing strategy. Your saved parameters were preserved.',
    INVALID_AMOUNT: 'Enter a whole, non-negative number of lamports (up to 39 digits).',
    LOCAL_SESSION_REQUIRED: 'Your local session expired. Reload the panel to reconnect.',
    CSRF_REJECTED: 'The local session could not be verified. Reload the panel to reconnect.',
  };
  return (
    messages[code] ??
    'The request could not be completed. Check your configuration and local API, then try again.'
  );
}
class RequestError extends Error {
  constructor(readonly code: string) {
    super(errorMessage(code));
  }
}
async function read<T>(path: string, token?: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers:
      body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-CSRF': token ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as T & { code?: string };
  if (!response.ok) throw new RequestError(value.code ?? 'UNAVAILABLE');
  return value;
}
let pendingSession: Promise<{ csrfToken: string }> | undefined;
function openSession(): Promise<{ csrfToken: string }> {
  pendingSession ??= read<{ csrfToken: string }>('/control/session').finally(() => {
    pendingSession = undefined;
  });
  return pendingSession;
}
export type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: BotControlSnapshot };
export function App() {
  const [state, setState] = useState<PanelState>({ status: 'loading' }),
    [selected, setSelected] = useState<string>('new'),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [failure, setFailure] = useState(''),
    [live, setLive] = useState(false);
  const focusReturn = useRef(new DialogFocusReturn());
  useEffect(() => {
    focusReturn.current.restore(live, busy);
  }, [live, busy]);
  async function load(reconnect = false) {
    try {
      if (reconnect) {
        const session = await openSession();
        setToken(session.csrfToken);
      }
      const snapshot = await read<BotControlSnapshot>('/control');
      setState({ status: 'ready', snapshot });
      if (reconnect) setSelected(snapshot.bots[0]?.id ?? 'new');
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Local API is unavailable.',
      });
    }
  }
  useEffect(() => {
    let cancelled = false;
    openSession()
      .then(async (session) => {
        const snapshot = await read<BotControlSnapshot>('/control');
        if (!cancelled) {
          setToken(session.csrfToken);
          setState({ status: 'ready', snapshot });
          setSelected(snapshot.bots[0]?.id ?? 'new');
        }
      })
      .catch((error) => {
        if (!cancelled)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Local API is unavailable.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function mutation(path: string, method: string, body: unknown, message: string) {
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      const bot = await read<ControlledBot>(path, token, method, body);
      // Refetch authoritative state after every success; a rejection never changes visible mode.
      const snapshot = await read<BotControlSnapshot>('/control');
      setState({ status: 'ready', snapshot });
      setSelected(bot.id);
      setNotice(
        message +
          (bot.mode === 'off' && bot.openPositions > 0
            ? ' Open positions are now unmanaged; no liquidation was performed.'
            : ''),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The local API is unavailable.');
    } finally {
      setBusy(false);
    }
  }
  const bot =
    state.status === 'ready' ? state.snapshot.bots.find((b) => b.id === selected) : undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Memecoin Bots home">
          <span className="brand-mark">
            m<span>·</span>
          </span>
          <span>
            MEMECOIN
            <br />
            <b>BOTS</b>
          </span>
        </a>
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <div className="nav-active">
          <span aria-hidden="true">▦</span> Bot controls{' '}
          <span className="nav-count">
            {state.status === 'ready' ? state.snapshot.bots.length : '—'}
          </span>
        </div>
        <div className="sidebar-bottom">
          <span className="connection-dot" /> LOCAL ENVIRONMENT<p>Paper first. Owner operated.</p>
          <small>Experimental software · Solana</small>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <div className="eyebrow">WORKSPACE / BOT CONTROLS</div>
            <h1>
              Your bots, under control<span>.</span>
            </h1>
            <p>Configure a strategy. Set its limits. Keep execution in paper.</p>
          </div>
          <span className="local-badge">
            <span className="connection-dot" /> LOCAL ONLY
          </span>
        </header>
        <div className="safety-banner">
          <span className="safety-icon" aria-hidden="true">
            ◈
          </span>
          <div>
            <strong>Paper trading environment</strong>
            <p>
              Paper balances are simulated. All strategies are currently unavailable. No real funds
              can move.
            </p>
          </div>
          <span className="locked-label">LIVE LOCKED</span>
        </div>
        {state.status === 'loading' && (
          <section className="state-card" role="status">
            <div className="eyebrow">CONNECTING</div>
            <h2>Loading your workspace…</h2>
            <p>Reading bot configuration from the local API.</p>
          </section>
        )}
        {state.status === 'error' && (
          <section className="state-card" role="alert">
            <h2>Local API unavailable</h2>
            <p>{state.message}</p>
            <p>
              Start the API with <code>pnpm dev:api</code> and the dashboard with{' '}
              <code>pnpm dev:dashboard</code>.
            </p>
            <button onClick={() => void load(true)}>Reconnect</button>
          </section>
        )}
        {state.status === 'ready' && (
          <>
            <div className="section-heading">
              <div>
                <h2>
                  Bot workspace{' '}
                  <span>{state.snapshot.bots.length.toString().padStart(2, '0')}</span>
                </h2>
                <p>Configuration stays in your local database.</p>
              </div>
              <button
                onClick={() => {
                  setSelected('new');
                  setFailure('');
                  setNotice('');
                }}
                disabled={busy}
              >
                ＋ Create bot
              </button>
            </div>
            <div className="control-layout">
              <section className="bot-list" aria-label="Your bots">
                {state.snapshot.bots.length === 0 ? (
                  <div className="empty-bots">
                    <span aria-hidden="true">＋</span>
                    <h3>Your first bot starts here</h3>
                    <p>Prepare a wallet offline, then create a paper configuration.</p>
                  </div>
                ) : (
                  state.snapshot.bots.map((b) => (
                    <button
                      className={`bot-card ${selected === b.id ? 'selected' : ''}`}
                      key={b.id}
                      onClick={() => {
                        setSelected(b.id);
                        setFailure('');
                        setNotice('');
                      }}
                      disabled={busy}
                    >
                      <div className="bot-card-top">
                        <span className="bot-avatar">{b.name.slice(0, 1).toUpperCase()}</span>
                        <span className={`mode-pill ${b.mode}`}>{b.mode.toUpperCase()}</span>
                      </div>
                      <h3>{b.name}</h3>
                      <p>
                        {state.snapshot.strategies.find((s) => s.id === b.strategy)?.name ??
                          b.strategy}
                      </p>
                      <div className="bot-card-bottom">
                        <span>{b.riskProfileId}</span>
                        <span>
                          {formatSol(b.paperBankrollLamports)} <small>paper SOL</small>
                        </span>
                      </div>
                      <div className="strategy-unavailable">○ Strategy unavailable</div>
                    </button>
                  ))
                )}
              </section>
              <section className="editor" aria-label={bot ? 'Bot configuration' : 'Create bot'}>
                <div className="editor-header">
                  <div className="eyebrow">{bot ? 'CONFIGURATION' : 'NEW CONFIGURATION'}</div>
                  <h2>{bot ? 'Bot details' : 'Create a paper bot'}</h2>
                  <p>
                    {bot
                      ? `Revision ${bot.revision} · Changes apply to future work.`
                      : 'Pair one strategy, one risk profile and one prepared wallet.'}
                  </p>
                </div>
                {notice && (
                  <p role="status" className="success-message">
                    {notice}
                  </p>
                )}
                {failure && (
                  <div role="alert" className="error-message">
                    <p>{failure}</p>
                    <button
                      className="text-button"
                      onClick={() => {
                        setFailure('');
                        setNotice('Reloaded current configuration.');
                        void load();
                      }}
                    >
                      Reload current configuration
                    </button>
                  </div>
                )}
                <BotForm
                  key={`${selected}:${bot?.revision ?? 'new'}`}
                  snapshot={state.snapshot}
                  bot={bot}
                  busy={busy}
                  onSave={(config) =>
                    void mutation(
                      bot ? `/control/bots/${bot.id}` : '/control/bots',
                      bot ? 'PUT' : 'POST',
                      bot ? { ...config, revision: bot.revision } : config,
                      bot
                        ? 'Configuration saved.'
                        : 'Paper bot created. Strategy execution remains unavailable.',
                    )
                  }
                />
                {bot && (
                  <div className="mode-controls">
                    <div>
                      <h3>Execution mode</h3>
                      <p>
                        Off cancels pending paper orders. Open positions remain unmanaged until
                        paper resumes.
                      </p>
                      <p>
                        <strong>{bot.openPositions}</strong> open positions ·{' '}
                        <strong>{bot.pendingOrders}</strong> pending orders
                      </p>
                    </div>
                    <div className="mode-buttons">
                      <button
                        className="secondary"
                        disabled={busy || bot.mode === 'off'}
                        onClick={() =>
                          void mutation(
                            `/control/bots/${bot.id}/mode`,
                            'POST',
                            { revision: bot.revision, mode: 'off' },
                            'Bot switched off. Pending paper orders were cancelled.',
                          )
                        }
                      >
                        Switch off
                      </button>
                      <button
                        disabled={busy || bot.mode === 'paper'}
                        onClick={() =>
                          void mutation(
                            `/control/bots/${bot.id}/mode`,
                            'POST',
                            { revision: bot.revision, mode: 'paper' },
                            'Paper mode resumed. Cancelled orders stay cancelled.',
                          )
                        }
                      >
                        Resume paper
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={(event) => {
                          focusReturn.current.remember(event.currentTarget);
                          setLive(true);
                        }}
                      >
                        Live mode · unavailable ↗
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
        <section className="risk-warning" role="note" aria-label="Risk warning">
          <span className="eyebrow">UNDERSTAND THE RISK</span>
          <h2>Experimental tools. Real responsibility.</h2>
          <p>
            <strong>Risk warning.</strong> {RISK_WARNING}
          </p>
        </section>
        <footer>
          MEMECOIN BOTS <span>Local control panel · Paper-first experimental software</span>
        </footer>
      </main>
      {live && bot && (
        <LiveDialog
          busy={busy}
          onClose={() => setLive(false)}
          onConfirm={() => {
            setLive(false);
            void mutation(
              `/control/bots/${bot.id}/mode`,
              'POST',
              {
                mode: 'live',
                revision: bot.revision,
                confirmation: 'I understand live trading risks',
              },
              '',
            );
          }}
        />
      )}
    </div>
  );
}
export function BotForm({
  snapshot,
  bot,
  busy,
  onSave,
}: {
  snapshot: BotControlSnapshot;
  bot?: ControlledBot | undefined;
  busy: boolean;
  onSave: (input: Omit<BotConfiguration, 'strategyParams'> | CreateBotRequest) => void;
}) {
  const [name, setName] = useState(bot?.name ?? ''),
    [strategy, setStrategy] = useState(bot?.strategy ?? snapshot.strategies[0]?.id ?? ''),
    [profile, setProfile] = useState(bot?.riskProfileId ?? 'balanced'),
    [wallet, setWallet] = useState(bot?.walletId ?? snapshot.wallets[0]?.id ?? ''),
    [budget, setBudget] = useState('1000000000'),
    [invalid, setInvalid] = useState('');
  const hasLegacyParams = Object.keys(bot?.strategyParams ?? {}).length > 0;
  const descriptor = snapshot.strategies.find((s) => s.id === strategy),
    policy = snapshot.profiles.find((p) => p.id === profile),
    selectedWallet = snapshot.wallets.find((w) => w.id === wallet);
  const unusual = descriptor && !descriptor.recommendedProfiles.includes(profile);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setInvalid('');
        if (!bot && !/^(0|[1-9][0-9]{0,38})$/.test(budget)) {
          setInvalid(errorMessage('INVALID_AMOUNT'));
          return;
        }
        const config = { name, strategy, riskProfileId: profile };
        onSave(
          bot
            ? config
            : { ...config, strategyParams: {}, walletId: wallet, paperBankrollLamports: budget },
        );
      }}
    >
      <fieldset disabled={busy}>
        <label>
          Bot name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Momentum observer"
            autoComplete="off"
          />
        </label>
        <div className="field-row">
          <label>
            Strategy
            <select
              disabled={hasLegacyParams}
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              {!descriptor && bot && (
                <option value={bot.strategy}>{bot.strategy} (legacy configuration)</option>
              )}
              {snapshot.strategies.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Risk profile
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              {snapshot.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-hint">
          {hasLegacyParams
            ? 'Existing strategy parameters are preserved. Changing this strategy requires an explicit offline review; parameter editing is unavailable here.'
            : 'Strategy configuration only. Implementation and parameter settings are unavailable.'}
        </p>
        {unusual && (
          <p role="note" className="pairing-warning">
            Unusual pairing: {descriptor.name} is usually paired with{' '}
            {descriptor.recommendedProfiles.join(' or ')}. You may still save this combination.
          </p>
        )}
        {!descriptor && (
          <p className="pairing-warning">
            Legacy strategy ID. No pairing recommendation is available.
          </p>
        )}
        {policy && (
          <div className="profile-summary">
            <div className="summary-title">
              {policy.displayName} <span>PROFILE LIMITS</span>
            </div>
            <dl>
              <div>
                <dt>Position size</dt>
                <dd>{Number(policy.positionFraction) * 100}%</dd>
              </div>
              <div>
                <dt>Stop distance</dt>
                <dd>{Number(policy.stopLossFraction) * 100}%</dd>
              </div>
              <div>
                <dt>Max positions</dt>
                <dd>{policy.maxOpenPositions}</dd>
              </div>
              <div>
                <dt>Min reward / risk</dt>
                <dd>{policy.minRewardRisk}×</dd>
              </div>
              <div>
                <dt>Daily loss limit</dt>
                <dd>{Number(policy.dailyLossLimitFraction) * 100}%</dd>
              </div>
              <div>
                <dt>Slippage limit</dt>
                <dd>{policy.maxSlippageBps} bps</dd>
              </div>
            </dl>
            <p>
              {policy.safetyMode} safety · score ≥ {policy.minSafetyScore} · max hold{' '}
              {policy.maxHoldMinutes} min
            </p>
          </div>
        )}
        <div className="wallet-section">
          <h3>Dedicated wallet</h3>
          {bot ? (
            <>
              <div className="public-key">{bot.publicKey}</div>
              <p className="field-hint">Wallet association is fixed after creation.</p>
            </>
          ) : snapshot.wallets.length === 0 ? (
            <div className="wallet-empty">
              <strong>No prepared wallets available</strong>
              <p>
                Prepare a wallet with the offline owner command, then reload the panel. The browser
                never creates or imports private keys.
              </p>
              <code>pnpm wallet prepare &lt; request.json 3&lt; /protected/master-key</code>
              <p>
                Request fields: walletId (stable UUID), label, spendCapLamports (integer string),
                vaultDirectory (private absolute directory outside this repository). See{' '}
                <code>docs/bot-control.md</code> for exact setup and safe retry instructions.
              </p>
            </div>
          ) : (
            <label>
              Prepared wallet
              <select value={wallet} onChange={(e) => setWallet(e.target.value)}>
                {snapshot.wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label} · {w.publicKey.slice(0, 8)}…{w.publicKey.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedWallet && !bot && <div className="public-key">{selectedWallet.publicKey}</div>}
          <dl className="balance-lines">
            <div>
              <dt>Wallet spend cap</dt>
              <dd>
                {(bot?.spendCapLamports ?? selectedWallet?.spendCapLamports) != null
                  ? `${formatSol((bot?.spendCapLamports ?? selectedWallet?.spendCapLamports)!)} SOL`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Observed chain balance</dt>
              <dd>
                {bot?.observedBalanceLamports != null
                  ? `${formatSol(bot.observedBalanceLamports)} SOL`
                  : 'Not observed'}
              </dd>
            </div>
          </dl>
          <p className="field-hint">
            Wallet cap is a limit, not a balance. Prepared metadata does not establish live
            readiness.
            {bot?.balanceObservedAt ? ` Last chain observation: ${bot.balanceObservedAt}.` : ''}
          </p>
        </div>
        {bot ? (
          <div className="paper-cash">
            <span>Simulated liquid paper cash</span>
            <strong>{formatSol(bot.paperBankrollLamports)} SOL</strong>
            <p>
              Runtime cash is read-only here. No real wallet funding is required for paper
              accounting.
            </p>
          </div>
        ) : (
          <label>
            Initial paper bankroll <span className="unit-label">LAMPORTS · SIMULATED</span>
            <input
              required
              inputMode="numeric"
              pattern="(0|[1-9][0-9]{0,38})"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
            <span className="field-hint">
              1 SOL = 1,000,000,000 lamports. Zero creates an unfunded configuration.
            </span>
          </label>
        )}
        {invalid && (
          <p role="alert" className="error-message">
            {invalid}
          </p>
        )}
        <div className="form-footer">
          <span>
            {bot
              ? 'Wallet and paper cash cannot be reassigned here.'
              : 'Starts in paper mode. No strategy can run yet.'}
          </span>
          <button disabled={busy || (!bot && !selectedWallet)} type="submit">
            {busy ? 'Saving…' : bot ? 'Save configuration' : 'Create paper bot'}{' '}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function LiveDialog({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [checked, setChecked] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose} aria-labelledby="live-title">
      <div className="eyebrow">LIVE TRADING LOCKED</div>
      <h2 id="live-title">Real funds need real safeguards.</h2>
      <p>
        Live trading could spend and lose the entire wallet balance. It requires a working live
        executor, risk approval and a kill switch.
      </p>
      <p>
        Those safeguards are not implemented. Confirming this request will be refused by the server
        and your bot will keep its current mode.
      </p>
      <label className="checkbox-label">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I
        understand live trading risks
      </label>
      <div className="dialog-actions">
        <button autoFocus className="secondary" onClick={onClose}>
          Keep current mode
        </button>
        <button disabled={!checked || busy} onClick={onConfirm}>
          Check live availability
        </button>
      </div>
    </dialog>
  );
}

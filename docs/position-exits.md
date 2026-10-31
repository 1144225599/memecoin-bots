# Paper position exit manager (BOT-14)

Run migrations, then use the separate supervised exit process:

```sh
pnpm exit once                  # one bounded round, up to 20 eligible positions
pnpm exit once <botId>          # one bot
pnpm exit watch [botId]         # poll until SIGINT/SIGTERM
pnpm exit inspect <positionId>  # saved policy, state and immutable decisions
```

These commands consume actual PostgreSQL paper positions and execute only through
PaperBroker. They never sign, send or move real funds. The default execution scenario
is explicitly MODEL paper-v1: zero latency/adverse slippage/failure, full quantity,
5,000 network-fee lamports and zero priority-fee lamports. This is an experimental
paper assumption, not observed execution quality or a guaranteed stop fill.
`PAPER_QUOTE_MOCK_URL` accepts only loopback HTTP for deterministic owner tests.
Normal operation uses the existing read-only Jupiter adapter and optional configured
Jupiter API key. No swap transaction endpoint or signing adapter is used.

Migration 0014 snapshots the saved stop and ladder plus profile ID/revision,
trailing fraction, maximum hold time, slippage and price-evidence policy when a
position is inserted. Existing positions are adopted once using their saved stop
and remaining ladder and the then-current trailing/time settings; the adoption flag
is inspectable. Editing a profile does not rewrite an open position's policy.

The selected price policy is `net_exchange_less_fee_MODEL_v1`. A validated exact
held-amount token-to-SOL quote supplies net exchange lamports, less an explicit
saved MODEL allowance of 5,000 transaction-fee lamports. Exact mint, position ID,
raw amount and token decimals bind conversion to SOL per whole token. Integer
ratios carry all raw quantity, threshold and high-water comparisons. No USD quote
or invented SOL conversion is used. Bounded request age is at most five seconds;
Jupiter receipt/request time is explicitly MODEL and **does not prove source
freshness**. The quote adapter's strict chain-context policy fails closed when
unavailable; the initial saved default deliberately selects MODEL request age.
Valid quotes whose proceeds are at or below the saved fee allowance produce a
clamped-zero net liquidation mark: they can trigger protection without raising
high-water, while execution still requires actual quote and fee funding.
Invalid, delayed, expired, differently sized or unavailable evidence cannot
advance high-water or trigger a price exit. Accepted observations and provenance
are append-only, including observations that do not trigger. The high-water mark
starts from the first managed fresh observation and never decreases.

Priority is stop loss (`price <= saved stop`), trailing protection (`price <=
highWater * (1 - saved fraction)`), elapsed DB-time stop, then crossed TP steps in
saved step order. Time stops can make a durable pending decision without a price;
PaperBroker still needs a valid executable quote and sufficient fee cash. A
protective/time decision supersedes unfilled TP and stays latched until the
remaining holding sells. Turning a bot off prevents work and late settlement;
returning to paper resumes policy without resurrecting cancelled orders.

The first crossed TP (including zero-unit dust) or protective/time exit cancels
unfinished entry orders and freezes acquired original quantity under the same
bot-first lock used by broker settlement. A racing entry fill either commits first
and is included or observes cancellation and adds zero. Subsequent entries cannot
add tokens after freeze. Each TP wants `floor(originalRaw * sellFraction)`, never
a fraction of remaining holdings. A gap combines outstanding crossed allocations
into one fixed order, with sold units allocated in step order. Decisions and
submission do not advance progress; only immutable broker fill results do. Zero
allocations finish with an explicit `exit.tp_dust` audit and no zero-sized order.
The position's legacy `take_profit_remaining` view removes only completed steps;
the immutable policy and exact per-step fill counts retain the full history.

An active pointer reserves one immutable sell decision per position. Its receipt
binds the complete intent, exact position/bot/mint/mode, amount, expiry, limits and
close reason. An arbitrary `exit_manager` marker/reference is rejected at broker
registration, preparation and settlement. This separates application capabilities;
a malicious database administrator remains outside that boundary. Reducing sells
have no entry safety, R:R, max-position or daily-loss veto. Exact holdings and
paper fee cash still apply; `INSUFFICIENT_PAPER_SOL` is actionable and never records
a fictional sale.

Fenced 15-second leases and stable attempt keys survive competing/restarted workers.
Interrupted attempts recover their saved quote/draws rather than rerunning RNG.
Unavailable attempts reuse the active order with a new attempt key; terminal failed,
expired or cancelled orders requeue only remaining allocation into a new immutable
decision. Retry delay grows from two to at most 60 seconds. Reconciliation records
fills once, including recovery of a fully closed position after a crash between
broker commit and manager progress. No transaction holds a pooled client during
provider IO, sleep or an executor call; the real integration test runs at pool max=1.
Locks are bot, stable order IDs, position, then state/account.

Rounds are bounded to 100 positions maximum (20 in CLI), interleave bots and
rotate least-recently-checked positions to avoid starvation. IO is sequential and
quotes use the shared durable 20/minute, two-second request budget. The CLI permits
one bounded 2.1-second wait for cadence before a second amount-specific quote;
a minute-budget denial remains unavailable and retries later. Watcher progress
uses `exit_progress`, never a strategy heartbeat or a claim that strategy work is
complete. A production supervisor/engine lifecycle integration remains separate.

Tests use disposable PostgreSQL, deterministic quote paths, the actual broker and
CLI HTTP adapter. They cover thresholds, high-water rollback/staleness, time stops
without quotes, original TP fractions/gaps/dust, exact values above 2^53, partial
entry cancellation races, partial exits/restarts, forged receipts, lease fencing,
closed-fill recovery, off during settlement, fee insufficiency, snapshot adoption,
immutability and migration up/down/up. Stops can still fail or fill worse in real
markets; paper results are not evidence of profitability or live fill guarantees.

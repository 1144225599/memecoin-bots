# Paper risk admission (BOT-13)

`RiskManager` implements a concrete signal → decision → immutable admission →
`PaperBroker` pipeline. It cannot sign, send or enable live execution. Strategies
receive only the frozen `forStrategy(botId, configuredStrategy).submitSignal`
capability. There are no strategy implementations yet; known or legacy assignment
IDs are bound exactly, without claiming they can run. Sell signals receive
`EXIT_MANAGER_REQUIRED`; reductions belong to a separately authorized exit boundary.
The owner-only manual paper scenario remains explicit and separate.

## Evidence and exact sizing

Every entry requires a fresh, mint-bound absolute SOL target with provenance and
expiry. A target is an explicit forecast assumption, not a truth guarantee. Missing
targets are vetoed; no target is inferred from take-profit ladders. The profile owns
the stop distance; a strategy's suggested stop cannot weaken it.

Principal is `floor(unreserved liquid paper cash × positionFraction)`, hard capped
at 5%. Pending principal/fees and reserved exit fee cash are unavailable for sizing.
Open marked/unrealized holdings never increase this cash-only basis. Principal is
clamped down for explicit fee affordability before quoting; concurrent changes to
the quoted size produce a re-quote veto instead of silently changing the amount.
All cash/amount/fraction arithmetic uses integers and exact decimal ratios.

Net R:R uses the amount-specific quote's minimum token output. Target proceeds
and stop proceeds include the profile's adverse exit slippage and selected MODEL
adverse slippage. Reward subtracts principal plus entry and exit fees; loss is
principal minus conservative stop proceeds plus those fees. The exact comparison is
`reward × minRR.denominator >= loss × minRR.numerator`. The target must exceed
entry price and be at most 1000× entry; this broad plausibility bound is an
engineering guard, not a forecast recommendation. Stop prices round down to 30
decimal places; unrepresentably small prices are denied.

Engineering policy reserves **three entry attempt fees and one exit fee**. Attempts
include unavailable outcomes, so an interrupted or partial entry cannot accumulate
unbounded retries. After three outcomes the outstanding remainder is cancelled;
actual fills remain held. Only consumed principal and actual fees consume the
cumulative cap. Pending fee/stop-risk reserves transfer conservatively to open
positions as fills arrive. Replays return durable results and never charge twice.
Every executable cumulative partial-fill prefix must independently pass net R:R
with all fixed entry fees and the exit fee included; a full-size R:R pass alone
does not authorize a tiny partial. Settlement rechecks cumulative actual amounts.
The loss reserve keeps whole remaining attempt fees, plus exact incremental
principal stop-risk at the saved rounded stop price. The exit fee transfers once
to the open-position commitment. Amount-proportional minimum token floors make
the combined pending/open stop-risk nonincreasing across accepted partial fills.

Quotes use the existing explicitly selected `bounded_request_age_MODEL` policy,
at most 5 seconds, with MODEL network/priority costs and embedded swap fees already
reflected in net output. Later execution quotes must preserve the approved
amount-proportional minimum output. Unknown executable quote facts deny.
The risk pipeline reuses its immutable full-size admission quote for the first
broker attempt, retaining its original age/expiry and avoiding a second immediate
provider rate-budget request. Partial amounts still require fresh amount-specific quotes.

Liquidity comes from an injected trusted read-only adapter, bound to mint, value,
provenance and expiry. A missing adapter denies. Targets and liquidity must be at
most 30 seconds old, with at most a 60-second evidence interval. The CLI accepts
explicit owner-supplied liquidity assumptions; it does not manufacture a production
market-analysis adapter.

## Safety

Admission revalidates cached raw BOT-9 evidence under the exact current profile,
never `tokens.safety_passed`. All six checks remain mandatory. The following are
documented engineering mappings, not measured safe/profitable thresholds:

| Mode     | Max owner concentration | Max developer concentration | Evidence age |
| -------- | ----------------------- | --------------------------- | ------------ |
| strict   | 5%                      | 1%                          | 15 seconds   |
| standard | 10%                     | 5%                          | 30 seconds   |
| relaxed  | 20%                     | 10%                         | 60 seconds   |

The profile's minimum score is also applied, but cannot bypass any failed/unknown
check. Production refuses scenario evidence. Current live safety adapters lack
mandatory positive coverage, so production entries correctly remain denied.
An explicit owner paper scenario can exercise the successful pipeline and records
`scenario: true` in immutable assumptions/audit; the CLI labels its evidence mode.
An owner scenario manager cannot produce a strategy capability.

## Durable limits, authorization and accounting

Admission locks the bot first, then reloads assignment/configuration, profile
revision, cash, cap, streak, open positions and pending admissions. It refuses an
existing/pending bot+token entry and counts pending distinct tokens against the
position limit. Legacy holdings lacking a known risk commitment deny new entries.
No network, quote fetch or nested pooled transaction occurs under the locks.

The immutable receipt binds the complete canonical intent, bot configuration hash
(strategy/parameters/profile/mode/wallet), profile revision, model, safety snapshot,
fingerprint, target/quote assumptions and expiry. A `risk_manager` marker/reference
alone grants no authority. Registration, attempt preparation and settlement enforce
that binding. Profile/config edits, replaced safety cache evidence, expired evidence,
cash/cap changes and worse quotes cannot execute under an old receipt.
The durable losing streak is checked again before preparation and after quote IO;
a newly closed loss can revoke an already-pending entry. Terminal order status
also revokes the receipt, including after an off → paper resume.
Expired or stale authorizations are explicitly reconciled; process crashes do not release holds.
Cancellation/terminal-order triggers release pending holds in the same transaction,
including mode-control cancellation from another service.

`risk_paper_accounts` is a **simulated cumulative debit budget**, completely separate
from live `wallet_spend_state` and reservations. Both its explicit paper cap and the
wallet's configured public cap must permit the debit. A null wallet cap or missing
paper cap denies. No wallet balance, real SOL, key or live reservation is needed.
Consumed budget never resets on restart or sales. Lowering a paper cap below
consumption/reservations fails. Owner/manual orders on a managed account cannot
consume protected cash/cap; standalone manual-demo bots retain their owner exception.

Risk days use the UTC database day sampled under settlement locks before cash
changes. The immutable first-observed opening **book** capital is liquid cash plus
remaining position cost basis. Its daily allowance cannot be diluted by subsequent
cash top-ups or looser profile edits; tighter daily fractions apply conservatively.
Usage is the sum of gross negative realized settlement PnL, not net PnL: wins do
not replenish it. Partial sells allocate entry cost (including buy fees) with the
broker's exact conservative basis calculation, then subtract sell fees. Submitted
failed-attempt fees are loss events immediately and exactly once.

Pending/open stop-risk and fees also reserve daily allowance, and open commitments
carry across midnight. Opening a new UTC day resets realized-day usage, not open
exposure. Streaks count closed losing positions net all allocated fees and linked
failed fees. Partial exits do not advance streaks; a win resets, break-even retains
the current count. Failed attempts alone are not fictional closed trades.
Reducing sells bypass entry safety/RR/daily/streak/position-limit gates; exact holding,
paper fee-cash and cumulative budget availability remain required. Exits are never
guaranteed to fill.

Every veto, including malformed input and nonexistent bots/tokens, commits an
immutable decision and exact safe reason-code audit atomically, without inventing
order/token rows. Strategy free text is hashed for idempotency and not stored in
audit.
Every final no-fill outcome of a risk-approved broker attempt also commits exactly
one immutable, attempt-bound risk veto and reason-code audit, including quote,
budget, slippage and monotonic-clock failures. Replays do not duplicate that event.
An unavailable database fails closed with
`RISK_STORAGE_UNAVAILABLE_NO_DECISION_COMMITTED`; it never claims a durable veto.

## Local use and recovery

```sh
pnpm --filter @memebots/engine risk cap <bot-id> <paper-cap-lamports>
pnpm --filter @memebots/engine risk submit request.json
pnpm --filter @memebots/engine risk owner-scenario request.json
pnpm --filter @memebots/engine risk process request.json
pnpm --filter @memebots/engine risk reconcile <bot-id>
```

The existing bot must already have its offline-prepared wallet, public configured
cap, paper bankroll, assignment and profile. The bounded JSON file contains
`botId`, `strategy`, stable `key`, `signal`, `target`, `liquidity` and explicit
`model` (the BOT-11 PaperModel schema). `process` additionally uses `orderId` and the
same approved model to recover a persisted intent. `owner-scenario` can include
validated `safetyEvidence`; `submit` cannot promote it to production evidence.
The CLI commits admission before invoking the actual broker, prints decision/result
JSON, and has fixed redacted operational failures. Reuse execution keys for recovery;
use a new bounded attempt key only within the original three-attempt/expiry budget.

Migration 0013 has a reversible **empty-state** lifecycle. It refuses rollback once
decisions, PnL history, consumed budget or active commitments would be destroyed.
Retain/reconcile/archive that state explicitly instead of silently resetting risk.
ADR-2 remains **proposed for human review**; see the pointer in `docs/adr/README.md`.

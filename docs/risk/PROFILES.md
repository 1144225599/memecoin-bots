# Editable risk profiles (BOT-10)

These are persisted **paper-only configuration**. The [risk admission service](ADMISSION.md)
now consumes entry sizing, reward:risk and admission limits. Existing positions keep
their saved stop/ladder; editing a profile does not silently rewrite those exit rules.
All bots keep referencing the same stable profile ID after an edit.

| Profile      | Size | Stop | Take profit: original size @ gain | Trail | Min RR | Open positions | Daily loss | Safety   |
| ------------ | ---- | ---- | --------------------------------- | ----- | ------ | -------------- | ---------- | -------- |
| conservative | 1%   | 10%  | 50% @ +15%                        | 8%    | 1.5    | 3              | 3%         | strict   |
| balanced     | 2%   | 20%  | 40% @ +30%, 30% @ +60%            | 15%   | 2      | 5              | 6%         | standard |
| aggressive   | 4%   | 35%  | 30% @ +100%, 30% @ +200%          | 25%   | 3      | 8              | 12%        | standard |
| degen        | 5%   | 50%  | 25% @ +100%, 25% @ +400%          | 40%   | 5      | 10             | 20%        | relaxed  |

These numbers are literal specification values. A 2x price means `atGain: 1`,
3x means `2`, and 5x means `4`. Each sale fraction refers to the **original**
position. Trailing stops apply to the unsold remainder. A partial ladder requires
a trailing stop. The stated Degen claim that selling 25% at 2x recovers initial
cost is arithmetically inconsistent: it recovers half the initial cost. The literal
25% ladder is preserved. Min RR is independent of the first profit target and is
not validated as first-target/stop.

The following are editable **engineering defaults**, since the specification supplies
no numeric thresholds. They are initial paper policy settings, not evidence of
profitable or safe thresholds or runtime trading recommendations.

| Profile      | Max slippage (bps) | Min liquidity (USD) | Min safety score | Max hold (minutes) | Losing streak limit |
| ------------ | ------------------ | ------------------- | ---------------- | ------------------ | ------------------- |
| conservative | 100                | 100000              | 85               | 240                | 3                   |
| balanced     | 200                | 50000               | 75               | 360                | 4                   |
| aggressive   | 300                | 25000               | 65               | 240                | 5                   |
| degen        | 500                | 10000               | 55               | 120                | 5                   |

## Local editing

The CLI uses the same validated local `DATABASE_URL` as migrations:

```sh
pnpm --filter @memebots/db profiles list
pnpm --filter @memebots/db profiles get balanced
pnpm --filter @memebots/db profiles update balanced ./profile-edit.json
```

The edit file contains exactly `expectedRevision` from the most recent get and a
partial `changes` object. For example:

```json
{
  "expectedRevision": "1",
  "changes": {
    "positionFraction": "0.015",
    "maxSlippageBps": 150,
    "safetyMode": "strict"
  }
}
```

Decimal policy values are strings, preserving their exact value across PostgreSQL
and JSON. Use plain nonnegative decimals with at most 80 characters, without
exponents, whitespace, signs or NaN/Infinity. Integer counts, minutes, bps and scores
are JSON numbers. Ladder gains and sale fractions remain JSON numbers as in the
existing position format; use finite values and strictly ascending positive gains.
There are 1–100 ladder steps, each with exactly `atGain` and `sellFraction`.
Sales must be positive and sum to at most 1. Application validation sums their
decimal spellings exactly, avoiding floating point boundary errors.

Position size must be in (0, 0.05]; stop, trailing and daily loss fractions in
(0, 1); RR positive; liquidity nonnegative; slippage an integer in 1–5000; safety
score an integer in 1–100; and counts/times positive PostgreSQL integers.
Safety mode can only be strict, standard or relaxed and cannot be disabled.
All fields are validated after merging a partial edit; unknown mutation fields,
empty changes and malformed inputs fail. An 80-character decimal limit and
100-step ladder bound keep application audit payloads bounded. Legacy rows outside
those input limits remain readable but must be corrected before service editing.

Library callers use `listRiskProfiles`, `getRiskProfile` and `updateRiskProfile`
from `@memebots/db`. Updates require `expectedRevision` and an identified `actor`.
A row lock and database revision trigger ensure concurrent editors cannot silently
overwrite each other. `RiskProfileConflictError` means reload and reapply the edit.
CLI failures use a fixed message; inspect the current revision and validate the
configuration with core `validateRiskProfile` for detailed policy errors.

The edit and `risk_profile.edit_applied` audit event commit together; audit failure
rolls the edit back. Audit records contain bounded known policy fields, revision
and actor, omitting the free-form display name. Ladders in audit records use exact
PostgreSQL JSON text (up to 32 KiB, otherwise an explicit omission marker),
preserving legacy decimal precision.
Partial edits write only supplied fields, so untouched ladder precision is retained.
This event describes the owner service command; future BOT-12 database canonical
mutation events are complementary.
Raw SQL enforces the main numeric, safety, finite and ladder invariants, but should
not be used for routine edits because it bypasses this service's command audit.

## Migrations and rollback

Migration 0010 seeds absent IDs with `ON CONFLICT DO NOTHING`: existing owner rows
are never replaced. Legacy custom profiles receive safety `standard`. Existing rows
must satisfy the strengthened finite/ladder/display-name checks before migration;
correct any invalid legacy ladder explicitly instead of silently changing policy.

Rolling back 0010 removes its constraints, safety column and revision machinery,
but preserves **all profile rows and numeric edits**, including rows referenced by
bots. Safety tiers and revisions are metadata lost on rollback; when reapplying,
existing rows receive `standard` and fresh revision 1. Review safety tiers before
resuming use, and reload every edit token. A full rollback of initial schema 0001
still drops the tables. Routine migration retries preserve every field and revision.

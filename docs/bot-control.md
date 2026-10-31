# Local bot controls (BOT-15)

This panel configures paper bots; no strategy implementations or live executor are installed.
It is an owner-operated loopback application, not an internet-facing service or protection
against another hostile local OS user. Do not expose or tunnel either listener.
The architecture extension is [proposed ADR-2](https://projectbrain.onrender.com/projects/01M6939CB70ZX4PHQ6QQSFZ8H4/plan/rules/01M69XBB91T3BR535TT4BBBZVE), not an accepted decision.

## Start

Use Node 24 and pnpm 10, install dependencies and set `DATABASE_URL` to the local
PostgreSQL database. Run `pnpm db:migrate`, then in separate terminals:

```sh
pnpm dev:api
pnpm dev:dashboard
```

Open `http://127.0.0.1:5173/`. The API defaults to `127.0.0.1:3001`.
Vite sends `/api/*` to that API, stripping `/api`. `API_PORT` must match for both
processes if changed. `API_DASHBOARD_ORIGIN` defaults to `http://127.0.0.1:5173`;
set the API's value to the exact loopback origin if the Vite port changes.
The API accepts only those exact Host and Origin values. No wildcard CORS is enabled.
Use the printed loopback IP URL, not a different hostname. Ports must be explicit.

The panel reads `/api/control/session`, obtaining a one-hour, in-memory session
with an HttpOnly SameSite=Strict cookie and a random CSRF token. The token lives
only in React memory. All control reads require the local session; writes also
require JSON, an approved Origin and `X-Local-CSRF`. Session bootstrap itself
checks Host, Origin and Fetch Metadata. Reload after an API restart/session expiry.
Tokens and cookies never go in query strings, browser persistent storage or logs.
`/health` remains a public non-sensitive health endpoint. The offline CLI is a
separate local owner capability and does not use browser authentication.

## Prepare an unassigned wallet offline

The browser and API never generate/import keys or accept private key fields.
Legacy wallet metadata is not eligible for new bot creation. Each bot must claim
one actually prepared, unassigned encrypted wallet; association is fixed in the panel.
Preparation creates an encrypted file outside the repository before publishing
public metadata. Preparation does not fund the wallet or establish live readiness.

Use a protected local directory (0700) outside every Git repository and a protected
32-byte raw master-key file (0600). Keep that key separately and back it up securely.
Create the protected directory and master key once, outside the repository, for example
(adapt the absolute paths before running; never overwrite an existing key):

```sh
umask 077
mkdir -m 700 /absolute/protected
openssl rand -out /absolute/protected/master-key 32
```

Choose and retain a stable lowercase UUID for this preparation, for example from `uuidgen`.
Create a public `request.json` with exactly these fields (replace placeholders):

```json
{
  "walletId": "<lowercase stable UUID>",
  "label": "Dedicated paper observer",
  "spendCapLamports": "2000000000",
  "vaultDirectory": "/absolute/private/directory/vault"
}
```

Then run offline:

```sh
pnpm wallet prepare < request.json 3< /absolute/protected/master-key
```

Only public metadata is returned. If interrupted or the database fails, retain the
encrypted file and retry **the same walletId, key, label and cap**. Offline recovery
authenticates the saved envelope and derives its public address; it never generates
a replacement for an existing ID. `pnpm wallet inspect` with
`{"vaultDirectory":"/absolute/private/directory/vault"}` on stdin reports orphan/missing
IDs. If committed wallet metadata exists but the encrypted file is missing,
preparation refuses with `ORIGINAL_VAULT_RESTORE_REQUIRED`; restore the original
file from backup before retrying. A replacement key is never generated for that
identity. Per-wallet preparation is serialized on one database connection so
concurrent retries cannot race key identity. Metadata alone is not proof of a usable key.
A claimed wallet cannot be prepared again or reassigned by this command.
The API never reads the vault or receives its path or encryption key.

## Configure and control

Create with a name, strategy, risk profile, prepared wallet and initial simulated
bankroll as a decimal integer lamport string (1 SOL = 1,000,000,000 lamports).
All integers stay exact, including values beyond JavaScript's safe-number range.
Zero bankroll/cap is an unfunded configuration, not a tradable balance. Paper cash
and observed on-chain wallet balance are separately labeled; paper does not need real SOL.

Five configuration IDs are implementation choices corresponding to the five spec
strategies: `sniper`, `momentum`, `copy_trade`, `dip_buy`, `dca_grid`.
None is runnable yet; parameters accept only `{}` until a schema/implementation exists.
Existing legacy strategy IDs remain readable and can be retained during edits.
Existing parameters are preserved in PostgreSQL without JSON round-tripping during
name/profile edits. The panel cannot edit parameters; a strategy with nonempty
legacy parameters cannot be changed here and requires an explicit offline review.
Pairing guidance: sniper → aggressive/degen; momentum and copy_trade → balanced/aggressive;
dip_buy → conservative/balanced; dca_grid → conservative. Other pairings warn and remain allowed.

Config edits require the currently displayed bot revision and are refused while
active orders exist. Name-only changes leave a safe audit marker without copying
the name. Profile changes affect future entry configuration, not an assertion that
open-position exit policies change. The panel cannot alter wallet association or
runtime paper cash. Cap changes remain an explicit audited offline owner command.

Off locks the bot first, then its active paper orders in stable ID order, cancels
them and persists mode in one transaction. Historical attempts/fills and holdings
are retained. A fill committing before off is legitimate; a settlement after off
cannot fill. Off does not liquidate. Open positions become unmanaged while off;
paper resumes eligibility without reviving cancelled orders. The existing monitoring
mode trigger updates heartbeat expectations.

Live opens an explicit risk confirmation dialog. Even with confirmation, the server
always returns `LIVE_EXECUTOR_UNAVAILABLE` and records a safe refusal audit. It never
changes mode to live. Global runtime paper-only parsing and signing-material rejection
remain enforced. No transaction signing/sending is added.

## Disposable preview and checks

For local QA only, create a database whose name ends `_preview_test`, then run:

```sh
DATABASE_URL=postgresql://.../bot_control_preview_test pnpm exec tsx --conditions=@memebots/source scripts/bot-control-preview.ts
```

This uses the actual offline prepare service for three temporary encrypted wallets
and leaves bots empty for the browser create flow. No files are written into the
repository. The random master key is discarded, so **never fund these disposable wallets**.
Remove the temporary directory printed by the command after QA and drop the disposable database.
Do not run the preview seed against a personal-use database.

Run `pnpm check`. Integration tests require `TEST_DATABASE_URL` ending `_test` and
`REQUIRE_DB_TESTS=1`; market tests use a separate `MARKET_DATA_TEST_DATABASE_URL` with
`REQUIRE_MARKET_DATA_TESTS=1`. Tests wipe their schemas and generate only ephemeral
wallet material. The BOT15 suite covers prepare/recovery, claim race/rollback,
exact cash, config/name audits, session-authenticated API create/edit/off/paper,
live refusal, mode-monitoring expectations, revision conflicts and settlement fencing.

# Memecoin Bots

Automated, **paper-first** trading bots for memecoins on Solana. Each bot pairs one
**strategy** (how it finds trades) with one **risk profile** (Conservative, Balanced,
Aggressive or Degen: how much it bets, where it cuts losses and takes profit). An
independent risk manager sizes every order and can veto any trade.

Planning, tasks and decisions live in ProjectBrain, project **BOT**. This repository
holds the code.

> **Risk warning.** This software trades memecoins automatically. Memecoins are extremely
> volatile and speculative; most lose most or all of their value, and many are scams (rug
> pulls, honeypots). Automated trading can lose money faster than manual trading, and
> software bugs, network outages, failed transactions, slippage and MEV can cause losses
> beyond the configured limits. Backtests and paper trading overstate real results. Stop
> losses are not guaranteed to fill. This is a personal experimental tool, not financial,
> investment, legal or tax advice. Only use money you can afford to lose entirely. You
> alone are responsible for your trades and for any taxes owed.

## Status

The scaffold (BOT-3) now uses shared typed configuration and redacted logging (BOT-4).
Both services validate their settings before starting. An opt-in read-only discovery
listener streams new pools and pump.fun launches (BOT-6); see
[discovery setup, coverage and limits](docs/architecture/DISCOVERY.md). Nothing can trade real funds:
the runtime accepts `paper` mode only and rejects wallet signing material.

## Layout

| Path              | What it is                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `packages/core`   | Shared types and constants: bot modes, risk profile names, strategy signals, the risk warning |
| `packages/config` | Shared startup validation, secret wrappers, redacted logging and encrypted secret envelopes   |
| `packages/db`     | PostgreSQL schema, migrations and data access (see its README)                                |
| `apps/engine`     | The bot engine (market data → strategies → risk manager → executor)                           |
| `apps/api`        | HTTP API for the dashboard (Fastify)                                                          |
| `apps/dashboard`  | Web dashboard (React + Vite)                                                                  |
| `scripts/`        | Repository checks, such as the secret scanner                                                 |
| `docs/`           | Architecture and decision records                                                             |

## Run it locally

Needs **Node.js 24** (see `.nvmrc`) and **pnpm 10** (`corepack enable` sets it up).

```bash
corepack enable
pnpm install
cp .env.example .env
```

The API and engine dev/start commands read the root `.env` if it exists. It contains
only local demo defaults; real credentials must come from a protected environment,
secret manager, or encrypted configuration as described in [configuration](docs/configuration.md).
`DATABASE_URL` is required even before a database connection is opened. The default
market-data mode is offline fixtures. The API binds only to `127.0.0.1`.

Start PostgreSQL (or use a local install) and create the tables:

```bash
docker compose up -d postgres   # creates the memebots and memebots_test databases
pnpm db:migrate                 # reads DATABASE_URL from .env, like the API and engine
```

Start each part in its own terminal:

```bash
pnpm dev:engine      # engine in paper mode, discovery disabled by default
pnpm dev:api         # API on http://127.0.0.1:3001/health
pnpm dev:dashboard   # dashboard on http://127.0.0.1:5173
```

For free public read-only discovery, run `MARKET_DATA_ENABLED=true pnpm dev:engine`.
This is independent of `BOT_MARKET_DATA`, which may remain `fixtures`.

The engine now requires a migrated database for durable startup audit and bot heartbeat leases.
Run `pnpm monitor watch` as a separate supervised process for stall and provider alerts;
`pnpm monitor health` reads current state. See [monitoring and audit](docs/architecture/MONITORING.md).

Database commands: `pnpm db:migrate`, `pnpm db:status`, `pnpm db:rollback [steps]`
(see `packages/db/README.md`). The discovery listener itself does not open a database connection; engine monitoring owns its DB pool.

## Checks

`pnpm check` runs the repository validation suite:

| Command              | What it does                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:secrets` | Fails if a `.env` file, a Solana keypair or a private key is in the repository                                                        |
| `pnpm lint`          | ESLint and Prettier                                                                                                                   |
| `pnpm typecheck`     | TypeScript in strict mode, every package                                                                                              |
| `pnpm test`          | Vitest, every package. Database tests need `TEST_DATABASE_URL` (see `.env.example`); without it they are skipped locally, never in CI |
| `pnpm build`         | Builds every package                                                                                                                  |

CI (`.github/workflows/ci.yml`) runs these checks on every pull request and also
exercises `db:migrate`, `db:status`, `db:rollback`, then `db:migrate` against a
disposable database.

### Market snapshots (BOT-7)

The optional read-only collector batches tracked Solana tokens through the free DEX
Screener API and stores observations, unavailable outcomes and restart gaps in PostgreSQL.
It has no trading or signing interface. See [market data](docs/market-data.md) for
setup, data limitations, the 200-token capacity test and backup/restore.

## Secrets

- Never commit `.env`, keypair files or private keys. `.gitignore` covers the usual
  names, and `pnpm check:secrets` and CI catch anything that slips through.
- The paper runtime rejects wallet keys. [Offline wallet provisioning and durable spend authorization](docs/wallets.md) are separate from runtime startup; persisted-key access remains future live-executor work.
- The API/engine use the shared redacted logger; raw Fastify request/error logs are disabled.
- Encrypted secret envelopes are authenticated before use; the encryption key stays in a
  separate protected source. See [configuration and secrets](docs/configuration.md).
- Each bot has its own small hot wallet. Never point a bot at your main wallet.

## Rules for this project

- Personal use only: own money, no customers, no public trade signals.
- No wash trading, no pumps, no sandwiching other traders.
- Every fill is recorded with enough detail to serve as the tax record.

See `CONTRIBUTING.md` for how work flows through ProjectBrain.

### Paper broker (BOT-11)

An explicit order-processing CLI now simulates approved fixed-quantity paper orders
using read-only Jupiter V2 amount quotes, with durable exact accounting, deterministic
latency/slippage/failure scenarios and restart recovery. The owner demo is explicitly
marked as a manual paper scenario; no production risk manager or live execution is
enabled. See [paper execution and evidence limits](docs/paper-broker.md).

### Token safety evidence (BOT-9)

`pnpm scan:safety <mint> --once` collects bounded read-only classic-SPL RPC facts,
keeps durable evidence and policy history, and emits a fail-closed JSON report.
All six checks are mandatory. Positive live LP, developer attribution, sell
simulation and bundle coverage remain unsupported and explicitly deny. See
[token safety setup, engineering policies and coverage limits](docs/token-safety.md).

### Position exits (BOT-14)

`pnpm exit once`, `pnpm exit watch` and `pnpm exit inspect <positionId>` manage
actual paper holdings through durable stop, TP, trailing and time decisions and
PaperBroker fills. Policies are snapshotted, TP quantities use frozen original
holdings, and fill receipts drive restart-safe progress. See
[position exit setup, evidence and limits](docs/position-exits.md).

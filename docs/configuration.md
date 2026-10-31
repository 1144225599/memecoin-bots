# Configuration and secrets (BOT-4)

The API and engine call `createAppContext` from `@memebots/config` before starting.
It creates a shared secret registry/logger, loads validated immutable configuration,
and returns `undefined` on failure after writing a safe field-name-only error. Both
entrypoints then exit nonzero. No service starts with invalid settings.

Configuration never opens database/provider connections. The values below are
validated policy settings; future adapters must implement the rate and credit limits.
All defaults preserve ADR-1's free-only, local, paper-first scope.

| Setting                           | Rule/default                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | Required PostgreSQL URL, database name and loopback host; no query/fragment                   |
| `BOT_MODE`                        | `paper`; live, off and unknown values are rejected by this initial runtime                    |
| `MARKET_DATA_ENABLED`             | `false`; exact `true` opts into read-only pool/launch discovery independently of polling mode |
| `SOLANA_RPC_URL`                  | HTTP(S) discovery endpoint; free public mainnet by default; stored as a secret                |
| `SOLANA_WS_URL`                   | WS(S) discovery endpoint; free public mainnet by default; stored as a secret                  |
| `BOT_MARKET_DATA`                 | `fixtures`; `mainnet` requires a Helius key and still means paper trading                     |
| `API_HOST`                        | `127.0.0.1` only                                                                              |
| `API_PORT`                        | `3001`; integer 1024–65535                                                                    |
| `HELIUS_API_KEY`                  | Required for mainnet data, optional for fixtures; endpoint fixed to Helius mainnet            |
| `JUPITER_API_KEY`                 | Optional; no key means keyless access                                                         |
| `BOT_MONTHLY_SERVICE_BUDGET_USD`  | `0` only                                                                                      |
| `BOT_HELIUS_MONTHLY_CREDIT_STOP`  | `800000`, may only be lowered                                                                 |
| `BOT_JUPITER_REQUESTS_PER_MINUTE` | `20`, may only be lowered                                                                     |
| `BOT_WATCHLIST_SIZE`              | `10`, may only be lowered                                                                     |
| `BOT_SNAPSHOT_INTERVAL_MS`        | `30000`; 30000–3600000                                                                        |
| `BOT_MAX_DATA_AGE_MS`             | Larger of 60000 or the snapshot interval; cannot be shorter than the interval                 |

Unknown `BOT_*` settings fail rather than silently accepting typos. Signing-related
environment values are rejected. API/engine settings are read once at startup.
Existing `API_PORT` and `API_HOST` names are retained. Discovery uses validated
`SOLANA_RPC_URL`/`SOLANA_WS_URL` independently of the Helius polling setting: keep
`BOT_MARKET_DATA=fixtures` to use free public discovery without a provider key.
Discovery endpoints reject whitespace, control characters, fragments and incorrect
schemes. Complete URLs, decoded credentials and query token values are registered
for redaction; wrappers reveal only at the read-only fetch/WebSocket boundary.
The factory-level engine `off` isolation remains tested, but the shared startup
loader currently accepts only `paper` mode. Empty Telegram placeholders remain removed.

## Supplying secrets

Inject real `DATABASE_URL`, `HELIUS_API_KEY`, optional `JUPITER_API_KEY`, and any
credential-bearing `SOLANA_RPC_URL`/`SOLANA_WS_URL` through
an OS/secret-manager facility or protected environment. Do not put real credentials
in committed files or plaintext `.env` files. `.env.example` contains only demo
database credentials matching the local Docker service.

For an encrypted source, supply both:

- `BOT_ENCRYPTED_CONFIG`: a versioned JSON envelope returned by `encryptSecret`.
- `BOT_CONFIG_ENCRYPTION_KEY`: the canonical base64 encoding of a separate,
  cryptographically random 32-byte key from a protected source.

The authenticated plaintext is a JSON object containing only `DATABASE_URL`,
`HELIUS_API_KEY`, `JUPITER_API_KEY`, `SOLANA_RPC_URL`, and/or `SOLANA_WS_URL`. These supplement the environment; duplicate
definitions are rejected. Policy settings such as mode cannot be overridden by the
encrypted payload. Remove an example setting such as `DATABASE_URL` or `SOLANA_RPC_URL` when supplying
that same field encrypted.
Missing key/envelope pairs, tampering, malformed payloads and wrong keys fail startup
without printing the envelope, plaintext or key.

`encryptSecret(plaintext, key)` and `decryptSecret(envelope, key)` use Node's
AES-256-GCM with a random 12-byte nonce, a 16-byte tag, fixed versioned authenticated
context and a 64 KiB plaintext limit. They do not write files or load real wallet keys.
Persist only the encrypted envelope, with restricted access, atomic writes and safe
backup/recovery. Never persist its key beside it. `.gitignore` excludes vault/key
files, but ignoring a file does not encrypt it.

Key provisioning and safe storage remain deployment responsibilities. This is an
envelope format, not a password manager: the key is random bytes, not a password.
Encryption protects stored data without the key, not a compromised running process;
JavaScript strings cannot be reliably erased from memory.

## Logging boundary

The same registry that wraps configuration values powers the API/engine logger.
Secret wrappers reveal only through `reveal()`; normal JSON, strings and inspection
are redacted. The logger removes registered literal/common encoded values, sensitive
field values, URL credentials/query strings and recognized authorization/PEM forms.
It omits stacks/binary data, bounds traversal, and never invokes getters or `toJSON`.

Fastify's default logger is disabled. Response logs contain method/status only;
request URLs, authorization headers and bodies are not logged. Error events use the
redactor, and error responses never reflect raw provider/database error messages.
Engine status output uses the same logger. Invalid startup settings can fail before
secret registration, so that path logs fixed diagnostic fields only.

Additional runtime credentials must be registered before use. Do not log secrets
even with redaction: arbitrary unregistered transformations, direct console calls,
third-party sinks, crash dumps and OS inspection are outside this boundary. New
provider/DB integrations must keep their debug logging disabled or use this sink.

## Verification

Run `pnpm check` on Node 24. The workspace includes config, logger and authenticated
encryption tests, actual API/engine startup subprocess tests, and an injected HTTP
failure that checks both captured logs and the response for synthetic credentials.
No test uses real credentials, provider calls, signing or paid services.

Implementation references: [Node crypto](https://nodejs.org/api/crypto.html) and
[ADR-1](https://projectbrain.onrender.com/projects/01M6939CB70ZX4PHQ6QQSFZ8H4/plan/rules/01M698GPZT95V63DDRFRNJHJG7).

### Local control panel origin

`API_DASHBOARD_ORIGIN` defaults to `http://127.0.0.1:5173` and accepts only an exact
HTTP origin with hostname `127.0.0.1` and explicit port. The local session endpoint
and control API enforce Host/Origin/Fetch-Metadata; mutations additionally require
JSON and the current session's `X-Local-CSRF` header. Set `API_PORT` consistently
for API and Vite proxy if changing the API port. See [bot controls](bot-control.md).

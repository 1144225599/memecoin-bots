import { RISK_PROFILE_FIELDS, STRATEGY_CATALOG, validateRiskProfile } from '@memebots/core';
import type {
  BotConfiguration,
  BotControlSnapshot,
  ControlledBot,
  CreateBotRequest,
  PreparedWallet,
} from '@memebots/core';
import { recordAudit, setAuditActor } from './audit.js';
import { listRiskProfiles } from './risk-profiles.js';
import { withTransaction } from './pool.js';
import type { Pool, Queryable } from './pool.js';

export class BotControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
  ) {
    super(code);
  }
}
function fail(code: string, status = 400): never {
  throw new BotControlError(code, status);
}
export function controlObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail('INVALID_FIELDS');
  return value as Record<string, unknown>;
}
export function controlId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
    fail('INVALID_ID');
  return value;
}
export function controlRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) fail('INVALID_REVISION');
  return value;
}
export function controlAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) fail('INVALID_AMOUNT');
  return value;
}
function configuration(value: Record<string, unknown>, allowLegacy = false): BotConfiguration {
  if (
    typeof value.name !== 'string' ||
    value.name.trim() !== value.name ||
    value.name.length < 1 ||
    value.name.length > 80 ||
    Array.from(value.name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    fail('INVALID_NAME');
  if (
    typeof value.strategy !== 'string' ||
    (!STRATEGY_CATALOG.some((s) => s.id === value.strategy) &&
      (!allowLegacy || !/^[a-z][a-z0-9_]{1,39}$/.test(value.strategy)))
  )
    fail('UNKNOWN_STRATEGY');
  if (
    typeof value.riskProfileId !== 'string' ||
    !/^[a-z][a-z0-9_]{1,39}$/.test(value.riskProfileId)
  )
    fail('INVALID_PROFILE');
  // No implementation/config schema exists yet. Only the empty configuration is meaningful.
  if (
    !(allowLegacy && value.strategyParams === undefined) &&
    (!value.strategyParams ||
      typeof value.strategyParams !== 'object' ||
      Array.isArray(value.strategyParams) ||
      Object.keys(value.strategyParams).length !== 0)
  )
    fail('STRATEGY_PARAMETERS_UNAVAILABLE');
  return {
    name: value.name,
    strategy: value.strategy,
    riskProfileId: value.riskProfileId,
    strategyParams: {},
  };
}
const editable = ['name', 'strategy', 'strategyParams', 'riskProfileId'] as const;
const selection = `b.id,b.name,b.strategy,b.strategy_params AS "strategyParams",b.risk_profile_id AS "riskProfileId",b.wallet_id AS "walletId",b.mode,b.revision::text,b.paper_bankroll_lamports AS "paperBankrollLamports", w.public_key AS "publicKey", w.spend_cap_lamports AS "spendCapLamports", s.observed_balance_lamports AS "observedBalanceLamports", s.balance_observed_at::text AS "balanceObservedAt", (SELECT count(*)::int FROM positions p WHERE p.bot_id=b.id AND p.status='open') AS "openPositions", (SELECT count(*)::int FROM orders o WHERE o.bot_id=b.id AND o.status IN ('pending','submitted','partially_filled')) AS "pendingOrders",false AS "strategyAvailable"`;
export async function listControlledBots(db: Queryable): Promise<ControlledBot[]> {
  return (
    await db.query<ControlledBot>(
      `SELECT ${selection} FROM bots b JOIN wallets w ON w.id=b.wallet_id LEFT JOIN wallet_spend_state s ON s.wallet_id=w.id ORDER BY b.created_at,b.id`,
    )
  ).rows;
}
export async function getControlledBot(db: Queryable, id: string): Promise<ControlledBot> {
  controlId(id);
  const rows = await db.query<ControlledBot>(
    `SELECT ${selection} FROM bots b JOIN wallets w ON w.id=b.wallet_id LEFT JOIN wallet_spend_state s ON s.wallet_id=w.id WHERE b.id=$1`,
    [id],
  );
  return rows.rows[0] ?? fail('BOT_NOT_FOUND', 404);
}
export async function listPreparedWallets(db: Queryable): Promise<PreparedWallet[]> {
  return (
    await db.query<PreparedWallet>(
      `SELECT w.id,w.label,w.public_key AS "publicKey",w.spend_cap_lamports AS "spendCapLamports" FROM wallets w JOIN wallet_preparations p ON p.wallet_id=w.id WHERE p.claimed_bot_id IS NULL AND w.spend_cap_lamports IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bots b WHERE b.wallet_id=w.id) ORDER BY p.prepared_at,w.id`,
    )
  ).rows;
}
export async function listControlProfiles(db: Queryable) {
  const profiles = await listRiskProfiles(db);
  if (
    profiles.some(
      (p) =>
        validateRiskProfile(Object.fromEntries(RISK_PROFILE_FIELDS.map((k) => [k, p[k]]))).length >
        0,
    )
  )
    fail('INVALID_STORED_PROFILE', 503);
  return profiles;
}
export async function botControlSnapshot(db: Queryable): Promise<BotControlSnapshot> {
  const bots = await listControlledBots(db),
    wallets = await listPreparedWallets(db),
    profiles = await listControlProfiles(db);
  return { bots, wallets, profiles, strategies: STRATEGY_CATALOG, liveTradingAvailable: false };
}
async function profile(db: Queryable, id: string): Promise<void> {
  const p = (await listRiskProfiles(db)).find((p) => p.id === id);
  if (
    !p ||
    validateRiskProfile(Object.fromEntries(RISK_PROFILE_FIELDS.map((k) => [k, p[k]]))).length > 0
  )
    fail('INVALID_PROFILE');
}
async function safely<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BotControlError) throw e;
    if ((e as { code?: string }).code === '23505') fail('CONFIGURATION_CONFLICT', 409);
    throw e;
  }
}
export async function createControlledBot(pool: Pool, input: unknown): Promise<ControlledBot> {
  const v = controlObject(input, [...editable, 'walletId', 'paperBankrollLamports']);
  const config = configuration(v),
    walletId = controlId(v.walletId),
    budget = controlAmount(v.paperBankrollLamports);
  const request: CreateBotRequest = { ...config, walletId, paperBankrollLamports: budget };
  return safely(() =>
    withTransaction(pool, async (db) => {
      await setAuditActor(db, 'owner');
      await profile(db, request.riskProfileId);
      // No bot exists yet: wallet serializes the single claim. All existing-bot writers lock bot first.
      const wallet = await db.query(
        `SELECT w.id FROM wallets w JOIN wallet_preparations p ON p.wallet_id=w.id WHERE w.id=$1 AND p.claimed_bot_id IS NULL AND w.spend_cap_lamports IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bots b WHERE b.wallet_id=w.id) FOR UPDATE OF w,p`,
        [walletId],
      );
      if (!wallet.rowCount) fail('WALLET_NOT_AVAILABLE', 409);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO bots(name,strategy,strategy_params,risk_profile_id,wallet_id,paper_bankroll_lamports,mode) VALUES($1,$2,'{}',$3,$4,$5,'paper') RETURNING id`,
        [config.name, config.strategy, config.riskProfileId, walletId, budget],
      );
      const id = inserted.rows[0]!.id;
      await db.query(
        'UPDATE wallet_preparations SET claimed_bot_id=$2,claimed_at=clock_timestamp() WHERE wallet_id=$1',
        [walletId, id],
      );
      return getControlledBot(db, id);
    }),
  );
}
async function lockBot(db: Queryable, id: string, revision: string): Promise<ControlledBot> {
  controlId(id);
  controlRevision(revision);
  if (!(await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [id])).rowCount)
    fail('BOT_NOT_FOUND', 404);
  const bot = await getControlledBot(db, id);
  if (bot.revision !== revision) fail('STALE_REVISION', 409);
  return bot;
}
export async function updateControlledBot(
  pool: Pool,
  id: string,
  input: unknown,
): Promise<ControlledBot> {
  const v = controlObject(input, [...editable, 'revision']),
    config = configuration(v, true),
    revision = controlRevision(v.revision);
  return safely(() =>
    withTransaction(pool, async (db) => {
      await setAuditActor(db, 'owner');
      const before = await lockBot(db, id, revision);
      if (
        !STRATEGY_CATALOG.some((s) => s.id === config.strategy) &&
        config.strategy !== before.strategy
      )
        fail('UNKNOWN_STRATEGY');
      if (config.strategy !== before.strategy && Object.keys(before.strategyParams).length > 0)
        fail('LEGACY_PARAMETERS_REQUIRE_OFFLINE_REVIEW', 409);
      const pending = await db.query(
        `SELECT id FROM orders WHERE bot_id=$1 AND status IN ('pending','submitted','partially_filled') ORDER BY id FOR UPDATE`,
        [id],
      );
      if (pending.rowCount) fail('PENDING_ORDERS', 409);
      await profile(db, config.riskProfileId);
      await db.query(
        // Parameter editing has no schema yet. Preserve stored JSON exactly, including legacy numeric precision.
        'UPDATE bots SET name=$2,strategy=$3,risk_profile_id=$4 WHERE id=$1',
        [id, config.name, config.strategy, config.riskProfileId],
      );
      return getControlledBot(db, id);
    }),
  );
}
export async function transitionControlledBot(
  pool: Pool,
  id: string,
  input: unknown,
): Promise<ControlledBot> {
  const v = controlObject(input, ['revision', 'mode', 'confirmation']),
    revision = controlRevision(v.revision);
  if (!['off', 'paper', 'live'].includes(v.mode as string)) fail('INVALID_MODE');
  if (v.confirmation !== undefined && v.confirmation !== 'I understand live trading risks')
    fail('INVALID_CONFIRMATION');
  const result = await withTransaction(pool, async (db) => {
    await setAuditActor(db, 'owner');
    await lockBot(db, id, revision);
    if (v.mode === 'live') {
      await recordAudit(db, {
        actor: 'owner',
        action: 'bot.mode_refused',
        entityType: 'bots',
        entityId: id,
        details: {
          reason: 'LIVE_EXECUTOR_UNAVAILABLE',
          confirmationPresent: v.confirmation === 'I understand live trading risks',
        },
      });
      return null;
    }
    if (v.mode === 'off') {
      await db.query(
        `SELECT id FROM orders WHERE bot_id=$1 AND mode='paper' AND status IN ('pending','submitted','partially_filled') ORDER BY id FOR UPDATE`,
        [id],
      );
      await db.query(
        `UPDATE orders SET status='cancelled',failure_reason='BOT_OFF' WHERE bot_id=$1 AND mode='paper' AND status IN ('pending','submitted','partially_filled')`,
        [id],
      );
    }
    await db.query('UPDATE bots SET mode=$2 WHERE id=$1', [id, v.mode]);
    return getControlledBot(db, id);
  });
  return result ?? fail('LIVE_EXECUTOR_UNAVAILABLE', 409);
}
